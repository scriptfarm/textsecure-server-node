/**
 * Copyright (C) 2015 Joe Bandenburg
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var querystring = require("querystring");
var crypto = require("crypto");
var express = require("express");
var cors = require("cors");
var bodyParser = require("body-parser");
var WebSocketServer = require("ws").Server;

var webSocketProtos = require("./WebSocketProtos");
var incomingPushMessageSignalProtos = require("./IncomingPushMessageSignalProtos");

var IncomingPushMessageSignal = incomingPushMessageSignalProtos.IncomingPushMessageSignal;
var WebSocketMessage = webSocketProtos.WebSocketMessage;

var unpackNumberDeviceString = function(numberString) {
    var numberAndDevice = numberString.split(".", 2);
    return {
        number: numberAndDevice[0],
        deviceId: numberAndDevice[1]
    };
};

var packNumberDevice = function(number, deviceId) {
    return number + "." + deviceId;
};

var parseAuth = function(req) {
    var auth = req.get("Authorization");
    var authString = new Buffer(auth.substring(6), "base64").toString("ascii");
    var authParts = authString.split(":", 2);
    var numberDevice = unpackNumberDeviceString(authParts[0]);
    return {
        number: numberDevice.number,
        deviceId: numberDevice.deviceId,
        password: authParts[1]
    };
};

function Contact() {
    this.devices = {};
}

function Server(contactStore, port) {
    var app = express();

    app.use(cors());
    app.use(bodyParser.json());

    app.get("/v1/accounts/:transport/code/:number", function(req, res) {
        contactStore.putContact(req.params.number, new Contact()).then(function() {
            res.status(200).end();
        });
    });

    app.put("/v1/accounts/code/:code", function(req, res) {
        var auth = parseAuth(req);
        contactStore.getContact(auth.number).then(function(contact) {
            contact.password = auth.password;
            var signalingKeyBytes = new Buffer(req.body.signalingKey, "base64");
            contact.signalingKey = {
                cipherKey: signalingKeyBytes.slice(0, 32),
                macKey: signalingKeyBytes.slice(32)
            };
            contact.registrationId = req.body.registrationId;
            return contactStore.putContact(auth.number, contact);
        }).then(function() {
            res.status(200).end();
        });
    });

    app.put("/v2/keys", function(req, res) {
        var auth = parseAuth(req);
        contactStore.getContact(auth.number).then(function(contact) {
            contact.devices[auth.deviceId] = {
                lastResortKey: req.body.lastResortKey,
                preKeys: req.body.preKeys.map(function(preKey) {
                    if (typeof preKey.keyId === "string") {
                        preKey.keyId = parseInt(preKey.keyId, 10);
                    }
                    return preKey;
                }),
                signedPreKey: req.body.signedPreKey
            };
            contact.identityKey = req.body.identityKey;
            return contactStore.putContact(auth.number, contact);
        }).then(function() {
            res.status(200).end();
        });
    });

    app.get("/v2/keys/:number/:device", function(req, res) {
        contactStore.getContact(req.params.number).then(function(otherContact) {
            if (!otherContact) {
                res.status(404).end();
            } else {
                if (req.params.device === "*") {
                    var response = {
                        identityKey: otherContact.identityKey,
                        devices: Object.keys(otherContact.devices).map(function(deviceId) {
                            var device = otherContact.devices[deviceId];
                            var preKey = device.preKeys.shift();
                            return {
                                signedPreKey: device.signedPreKey,
                                preKey: preKey,
                                registrationId: otherContact.registrationId,
                                deviceId: deviceId
                            };
                        })
                    };
                    return contactStore.putContact(req.params.number, otherContact).then(function() {
                        res.status(200).send(response);
                    });
                } else {
                    res.status(500).send("Not supported");
                }
            }
        });
    });

    app.put("/v1/messages/:number", function(req, res) {
        var auth = parseAuth(req);
        contactStore.getContact(req.params.number).then(function(toContact) {
            if (!toContact) {
                res.status(404).end();
                return;
            }
            req.body.messages.forEach(function(message) {
                var incomingPushMessageSignalBytes = new IncomingPushMessageSignal({
                    type: message.type,
                    source: auth.number,
                    sourceDevice: parseInt(auth.deviceId, 10),
                    timestamp: message.timestamp,
                    message: new Buffer(message.body, "base64")
                }).encode().toBuffer();

                var iv = crypto.randomBytes(16);
                var cipher = crypto.createCipheriv("aes-256-cbc", new Buffer(toContact.signalingKey.cipherKey), iv);
                var buffer1 = cipher.update(incomingPushMessageSignalBytes);
                var buffer2 = cipher.final();
                var encryptedIncomingPushMessageSignalBytes = Buffer.concat([buffer1, buffer2]);

                var versionByte = new Buffer([1]);
                var macingBytes = Buffer.concat([versionByte, iv, encryptedIncomingPushMessageSignalBytes]);

                var hmac = crypto.createHmac("sha256", new Buffer(toContact.signalingKey.macKey));
                hmac.update(macingBytes);
                var mac = hmac.digest().slice(0, 10);

                var finalMessage = Buffer.concat([versionByte, iv, encryptedIncomingPushMessageSignalBytes, mac]);

                var connectionId = packNumberDevice(req.params.number, message.destinationDeviceId);
                var connection = webSocketConnections[connectionId];
                if (connection) {
                    var webSocketMessageBytes = new WebSocketMessage({
                        type: WebSocketMessage.Type.REQUEST,
                        request: {
                            verb: "PUT",
                            path: "/api/v1/message",
                            body: finalMessage,
                            id: 1234
                        }
                    }).encode().toBuffer();
                    connection.send(webSocketMessageBytes);
                }
            });
            res.status(200).end();
        });
    });

    var webSocketConnections = {};

    var server = app.listen(port);

    var wss = new WebSocketServer({
        server: server,
        path: "/v1/websocket/",
        verifyClient: function(info, callback) {
            var query = querystring.parse(info.req.url.split("?", 2)[1]);
            if (!query.login) {
                return false;
            }
            query.login = unpackNumberDeviceString(query.login);
            contactStore.getContact(query.login.number).then(function(contact) {
                if (!contact) {
                    return false;
                }
                return contact.password === query.password;
            }).then(callback);
        }
    });
    wss.on("connection", function(ws) {
        var query = querystring.parse(ws.upgradeReq.url.split("?", 2)[1]);
        webSocketConnections[query.login] = ws;
        ws.on("close", function() {
            delete webSocketConnections[query.login];
        });
    });

    this.close = server.close.bind(server);
}

module.exports = Server;