var server = require('server');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Encoding = require('dw/crypto/Encoding');
var Mac = require('dw/crypto/Mac');
var Bytes = require('dw/util/Bytes');
var PaymentInstrument = require('dw/order/PaymentInstrument');
var Transaction = require('dw/system/Transaction');
var CustomerMgr = require('dw/customer/CustomerMgr');
var Logger = require('dw/system/Logger');
var array = require('*/cartridge/scripts/util/array');
var mapper = require('~/cartridge/scripts/util/mapper.js');
var tokenManagement = require('../scripts/http/tokenManagement');
var configObject = require('../configuration/index');
var cybersourceRestApi = require('../apiClient/index');
var OrderMgr = require('dw/order/OrderMgr');

var instance;

    server.use('tokenUpdate', function (req, res, next) {
        if (configObject.networkTokenizationEnabled && req.httpMethod === 'POST') {
            var digitalSignature = req.httpHeaders.get('v-c-signature');
            var payload = JSON.parse(req.body);
            var organizationId = configObject.merchantID;
            var message = JSON.stringify(payload.payload);

            if (validator(digitalSignature, message, organizationId)) {
                var webhookId = payload.webhookId;
                var data = payload.payload[0].data._links;
                var instrumentIdentifierLink = data.instrumentIdentifiers[0].href;
                var instrumentIdentifier = instrumentIdentifierLink.substring(instrumentIdentifierLink.lastIndexOf('/') + 1);
                var customerLink = data.customers[0].href;
                var customerId = customerLink.substring(customerLink.lastIndexOf('/') + 1);
                var paymentInstrument;
                if (data.paymentInstruments) {
                    var paymentInstrumentLink = data.paymentInstruments[0].href;
                    paymentInstrument = paymentInstrumentLink.substring(paymentInstrumentLink.lastIndexOf('/') + 1);
                }

                instance = new cybersourceRestApi.InstrumentIdentifierApi(configObject);
                var cardData; var cardNumber; var state;
                try { // eslint-disable-line no-useless-catch
                    instance.getInstrumentIdentifier(instrumentIdentifier, configObject.profileId, function (data, error, response) {
                        if (!error) {
                            cardData = data.tokenizedCard.card;
                            cardNumber = data.card.number;
                            state = data.tokenizedCard.state;
                        } else {
                            Logger.info('Card details does not exist');
                            res.setStatusCode(404);
                        }
                    });
                } catch (error) {
                    Logger.info('Token update failed'+ error);
                    res.setStatusCode(404);
                }

                if (state == 'ACTIVE') {
                    instance = new cybersourceRestApi.CustomerApi(configObject);
                    var email;
                    try { // eslint-disable-line no-useless-catch
                        instance.getCustomer(customerId, configObject.profileId, function (data, error, response) {
                            if (!error) {
                                email = data._embedded.defaultPaymentInstrument.billTo.email;
                            } else {
                                Logger.info('Customer data does not exist');
                                res.setStatusCode(404);
                            }
                        });
                    } catch (error) {
                        Logger.info('Token update failed'+ error);
                        res.setStatusCode(404);
                    }

                    var customer = CustomerMgr.getCustomerByLogin(email);
                    var wallet = customer.profile.wallet;
                    var paymentInstruments = wallet.getPaymentInstruments();
                    var paymentToDelete = array.find(paymentInstruments, function (item) {
                        var token = item.creditCardToken;
                        var tokenInfo = mapper.deserializeTokenInformation(token);
                        return instrumentIdentifier === tokenInfo.instrumentIdentifier.id;
                    });

                    Transaction.wrap(function () {
                        var cardHolder = paymentToDelete.creditCardHolder;
                        var cardType = paymentToDelete.creditCardType;
                        var cardToken = paymentToDelete.creditCardToken;
                        wallet.removePaymentInstrument(paymentToDelete);
                        var newPaymentInstrument = wallet.createPaymentInstrument(PaymentInstrument.METHOD_CREDIT_CARD);
                        newPaymentInstrument.setCreditCardHolder(cardHolder);
                        var newCardNumber = cardNumber.slice(0, -4) + cardData.suffix;
                        newPaymentInstrument.setCreditCardNumber(newCardNumber);
                        newPaymentInstrument.setCreditCardType(cardType);
                        newPaymentInstrument.setCreditCardExpirationMonth(Number(cardData.expirationMonth));
                        newPaymentInstrument.setCreditCardExpirationYear(Number(cardData.expirationYear));
                        if (empty(paymentInstrument)) {
                            var oldToken = mapper.deserializeTokenInformation(cardToken);
                            paymentInstrument = oldToken.paymentInstrument.id;
                        }
                        var tokenInfo = {
                            instrumentIdentifier: { id: instrumentIdentifier },
                            paymentInstrument: { id: paymentInstrument }
                        };

                        var token = mapper.serializeTokenInformation(tokenInfo);
                        newPaymentInstrument.setCreditCardToken(token);
                        res.setStatusCode(200);
                    });
                } else {
                    Logger.info('Network token state is not Active');
                    res.setStatusCode(404);
                }
            }
            else{
                res.setStatusCode(404);
            }
        }
        else{
            Logger.info('Network token updates disabled');
            res.setStatusCode(404);
        }
    });

    function validator(digitalSignature, message, merchantId) {
        var signatureParts;
        var timestamp;
        var keyId;
        try {
            signatureParts = digitalSignature.split(';');
            timestamp = parseInt(signatureParts[0].split('=')[1]);
            keyId = signatureParts[1].split('=')[1];
            signature = signatureParts[2].split('=')[1];
        } catch (e) {
            Logger.error('Invalid digital signature format');
        }

        if (isValidTimestamp(timestamp)) {
            const regeneratedSignature = regenerateSignature(timestamp, message, merchantId);
            if (constantTimeEquals(regeneratedSignature, Encoding.fromBase64(signature))) {
                return true;
            }
            Logger.error('No match in signature');
            return false;
        }
    }

    function constantTimeEquals(a, b) {
        var HMAC_SHA256_LENGTH = 32;
        if (a.getLength() !== HMAC_SHA256_LENGTH || b.getLength() !== HMAC_SHA256_LENGTH) {
            return false;
        }
        var result = 0;
        for (var i = 0; i < HMAC_SHA256_LENGTH; i++) {
            result |= (a.byteAt(i) ^ b.byteAt(i));
        }
        return result === 0;
    }

    function regenerateSignature(timestamp, message, merchantId) {
        const timestampedMessage = `${timestamp}.${message}`;
        const key = getSecurityKey(merchantId);
        try {
            var hmac = new Mac('HmacSHA256');
            return hmac.digest(new Bytes(timestampedMessage, 'utf8'), Encoding.fromBase64(key));
        } catch (e) {
            throw new Error('Failed to calculate hmac-sha256');
        }
    }

    function getSecurityKey(merchantId) {
        var obj = CustomObjectMgr.getCustomObject('Network Tokens Webhook', merchantId);
        return obj.custom.SecurityKey;
    }

    function isValidTimestamp(timestamp) {
        const tolerance = 60 * 60 * 1000;
        const currentTime = Date.now();
        return currentTime - timestamp < tolerance;
    }


/**
 * Modular decryption function using native platform APIs
 */
function decryptMLEPayload(jweString) {
    if (!jweString) return null;
    var JWE = require('dw/crypto/JWE');
    var KeyRef = require('dw/crypto/KeyRef');
    var alias = config.egressMleCertificateAlias || 'Cybersource_MLE_Egress_Private_Key';
    
    try {
        var jwe = JWE.parse(jweString.trim());
        jwe.decrypt(new KeyRef(alias));
        return jwe.getPayload();
    } catch (e) {
        Logger.error('decryptMLEPayload failed for alias "' + alias + '": ' + e.message);
        throw e;
    }
}

/**
 * Defensive Signature Validation
 */
function validateSignature(req, customObjectKey) {
    var digitalSignature = req.httpHeaders.get('v-c-signature');
    Logger.error('Validating signature for ' + customObjectKey + ': ' + digitalSignature);
    if (!digitalSignature || !req.body) return false;
    try {
        var signatureParts = digitalSignature.split(';');
        if (signatureParts.length < 3) return false;
        var ts = signatureParts[0].split('=')[1];
        var s = signatureParts[2].split('=')[1];
        if (Math.abs(Date.now() - parseInt(ts)) > 300000) return false;

        var obj = CustomObjectMgr.getCustomObject('CyberSource Webhook Subscription', customObjectKey);
        if (!obj && customObjectKey === 'tokenManagement') {
            obj = CustomObjectMgr.getCustomObject('Network Tokens Webhook', require('dw/system/Site').getCurrent().getCustomPreferenceValue('Cybersource_MerchantID'));
        }
        if (!obj || !obj.custom.SecurityKey) return false;

        var hmac = new Mac('HmacSHA256');
        var secret = Encoding.fromBase64(obj.custom.SecurityKey);
        
        var variations = [req.body];
        try {
            var jsonBody = JSON.parse(req.body);
            if (jsonBody.encryptedRequest) variations.push(jsonBody.encryptedRequest);
            if (jsonBody.payload) variations.push(JSON.stringify(jsonBody.payload));
        } catch (e) {}

        for (var i = 0; i < variations.length; i++) {
            var payloadToSign = variations[i];
            var regenerated = hmac.digest(new Bytes(ts + '.' + payloadToSign, 'utf8'), secret);
            if (regenerated.toString() === Encoding.fromBase64(s).toString()) return true;
        }
        return false;
    } catch (e) { 
        Logger.error('Error in validateSignature: ' + e.message);
        return false; 
    }
}

/**
 * Helper to decrypt payload if MLE is enabled
 */
function getDecryptedPayload(body) {
    var payload;
    try {
        payload = JSON.parse(body);
        var encryptedData = payload.encData || payload.encryptedRequest;
        if (encryptedData) {
            var decryptedString = decryptMLEPayload(encryptedData);
            payload = JSON.parse(decryptedString);
        }
    } catch (e) {
        if (body && body.split('.').length === 5) {
            try {
                var decryptedString = decryptMLEPayload(body);
                payload = JSON.parse(decryptedString);
            } catch (innerE) { throw innerE; }
        } else { throw e; }
    }
    return payload;
}

function handleDmNotification(req, res, next) {
    if (req.httpMethod === 'GET') {
        res.json({ success: true });
        return next();
    }
    if (!validateSignature(req, 'fraudManagement')) {
        res.setStatusCode(401);
        res.json({ success: false });
        return next();
    }

    try {
        var payload = getDecryptedPayload(req.body);
        if (!payload) throw new Error('Decrypted payload is empty');

        var details = (payload.payload && payload.payload.transactionResult) ? payload.payload.transactionResult.details : 
                      (payload.payload && payload.payload.length ? payload.payload[0].data : payload);
                      
        var orderId = details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null;
        if (!orderId) throw new Error('Missing Order ID');

        var order = OrderMgr.getOrder(orderId);
        if (!order) {
            res.setStatusCode(503);
            res.json({ success: false, message: 'Order not found, retrying...' });
            return next();
        }

        Transaction.wrap(function () {
            var eventType = payload.eventType || (payload.payload && payload.payload[0] ? payload.payload[0].eventType : null);
            if (eventType === 'risk.casemanagement.decision.accept') { 
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED); 
            } else if (eventType && eventType.indexOf('reject') > -1) { 
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_NOTCONFIRMED); 
            }
        });
        
        res.setStatusCode(200);
        res.json({ success: true });
    } catch (e) {
        Logger.error('dmNotification error: ' + e.message);
        res.setStatusCode(200);
        res.json({ success: false });
    }
    return next();
}

// DM Notifications
server.use('dmNotification', handleDmNotification);
server.use('novusDmNotification', handleDmNotification);

// APM Notifications
server.use('paymentNotification', function (req, res, next) {
    if (req.httpMethod === 'GET') {
        res.json({ success: true });
        return next();
    }

    if (!validateSignature(req, 'unifiedCheckout')) {
        Logger.error('paymentNotification: Signature validation failed');
        res.setStatusCode(401);
        res.json({ success: false });
        return next();
    }

    try {
        var payload = getDecryptedPayload(req.body);
        if (!payload) throw new Error('Decrypted payload is empty');

        var details = (payload.payload && payload.payload.transactionResult) ? payload.payload.transactionResult.details : 
                      (payload.payload && payload.payload.length ? payload.payload[0].data : payload);
                      
        var orderId = details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null;
        if (!orderId) throw new Error('Missing Order ID');

        var order = OrderMgr.getOrder(orderId);
        
        if (!order) {
            var retryCount = parseInt(payload.retryNumber || (req.httpHeaders.containsKey('v-c-retry-count') ? req.httpHeaders.get('v-c-retry-count') : 0), 10) || 0;

            Transaction.wrap(function () {
                var stagingObj = CustomObjectMgr.getCustomObject('CybersourceWebhookStaging', orderId) || CustomObjectMgr.createCustomObject('CybersourceWebhookStaging', orderId);
                
                if (retryCount >= 2) {
                    Logger.error('paymentNotification: CRITICAL - FINAL RETRY FAILED. Failed to create order ' + orderId + ' after all webhook retries. This is definitively an orphaned authorization.');
                } else if (stagingObj.custom.payload) {
                    Logger.warn('paymentNotification: Order ' + orderId + ' STILL not found on webhook retry (' + retryCount + '/3). Overwriting staged payload.');
                } else {
                    Logger.info('paymentNotification: Order ' + orderId + ' not found on initial delivery. Staging payload.');
                }
                stagingObj.custom.payload = JSON.stringify(payload);
            });
            
            if (retryCount >= 2) {
                res.setStatusCode(200);
                res.json({ success: true, message: 'Final retry acknowledged. Orphaned authorization staged.' });
            } else {
                res.setStatusCode(503); 
                res.json({ success: false, message: 'Order not yet created. Payload staged. Requesting retry as safety net.' });
            }
            return next();
        }
        
        Transaction.wrap(function () {
            if (['COMPLETED', 'SETTLED', 'AUTHORIZED'].indexOf(details.status) > -1) {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
            } else if (details.status === 'AUTHORIZED_PENDING_REVIEW') {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_NOTCONFIRMED);
            }

            var stagingObj = CustomObjectMgr.getCustomObject('CybersourceWebhookStaging', orderId);
            if (stagingObj) CustomObjectMgr.remove(stagingObj);
        });

        res.setStatusCode(200);
        res.json({ success: true });
    } catch (e) {
        Logger.error('paymentNotification error: ' + e.message);
        res.setStatusCode(200); 
        res.json({ success: false });
    }
    return next();
});


module.exports = server.exports();
