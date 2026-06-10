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
            
            var regeneratedSignature = regenerateSignature(timestamp, message, merchantId);
            
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
        
        var timestampedMessage = timestamp + '.' + message;
        var key = getSecurityKey(merchantId);
        
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
        
        var tolerance = 60 * 60 * 1000;
        var currentTime = Date.now();
        
        return currentTime - timestamp < tolerance;
    }


/**
 * Modular decryption function using native platform APIs
 */
function decryptMLEPayload(jweString) {
    if (!jweString) return null;
    var JWE = require('dw/crypto/JWE');
    var KeyRef = require('dw/crypto/KeyRef');
    
    // Fix: module requires the config as `configObject` (line 13); `config` was undefined and
    // threw ReferenceError on every MLE webhook, breaking decryption before the alias resolved.
    var alias = configObject.egressMleCertificateAlias || 'Cybersource_MLE_Egress_Private_Key';
    

    // Pin the JWE header before handing the payload to dw/crypto/JWE — defense-in-depth
    // against algorithm-confusion and a clearer error when a misrouted webhook arrives.
    var trimmed = jweString.trim();
    var headerB64 = trimmed.split('.')[0];
    if (headerB64) {
        try {
            var b64 = headerB64.replace(/-/g, '+').replace(/_/g, '/');
            var padLen = b64.length % 4;
            if (padLen === 2) b64 += '==';
            else if (padLen === 3) b64 += '=';
            var header = JSON.parse(Encoding.fromBase64(b64).toString());
            if (header.alg !== 'RSA-OAEP-256' || header.enc !== 'A256GCM') {
                Logger.error('decryptMLEPayload: unexpected JWE algorithms — alg=' + header.alg + ', enc=' + header.enc + '. Expected RSA-OAEP-256 + A256GCM per CyberSource webhook spec.');
                throw new Error('Unsupported JWE algorithms');
            }
        } catch (he) {
            if (he.message === 'Unsupported JWE algorithms') throw he;
            // Header parse failure — fall through; JWE.parse below will surface a clearer error.
        }
    }

    try {
        var jwe = JWE.parse(trimmed);
        jwe.decrypt(new KeyRef(alias));
        return jwe.getPayload();
    } catch (e) {
        Logger.error('decryptMLEPayload failed for alias "' + alias + '": ' + e.message + '. Verify the .p12 private key is uploaded under Administration > Operations > Private Keys and Certificates with this exact alias.');
        throw e;
    }
}

/**
 * Defensive Signature Validation
 */
function validateSignature(req, customObjectKey) {
    var digitalSignature = req.httpHeaders.get('v-c-signature');
    Logger.info('Validating signature for ' + customObjectKey);
    if (!digitalSignature || !req.body) return false;
    try {
        var signatureParts = digitalSignature.split(';');
        if (signatureParts.length < 3) return false;
        var ts = signatureParts[0].split('=')[1];
        var s = signatureParts[2].split('=')[1];
        if (Math.abs(Date.now() - parseInt(ts)) > 300000) return false;

        var obj = CustomObjectMgr.getCustomObject('CyberSource Webhook Subscription', customObjectKey);
        if (!obj || !obj.custom.SecurityKey) return false;

        var hmac = new Mac('HmacSHA256');
        var secret = Encoding.fromBase64(obj.custom.SecurityKey);

        // CyberSource signs `{timestamp}.{raw_body}`. The earlier 3-variant fallback
        // re-stringified parsed JSON, which can never byte-match the original payload.
        var regenerated = hmac.digest(new Bytes(ts + '.' + req.body, 'utf8'), secret);
        return regenerated.toString() === Encoding.fromBase64(s).toString();
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
                // Replicates DMOrderStatusUpdate.js cron behavior on ACCEPT.
                OrderMgr.placeOrder(order);
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                Logger.info('dmNotification: Order ( ' + orderId + ' ) successfully placed via case-management ACCEPT');
            } else if (eventType && eventType.indexOf('reject') > -1) {
                // Replicates DMOrderStatusUpdate.js cron behavior on REJECT.
                var reviewerComment = (details && details.riskInformation && details.riskInformation.reviewerComments)
                    || (details && details.reviewerComments)
                    || '';
                OrderMgr.failOrder(order, false);
                order.cancelDescription = reviewerComment;
                Logger.info('dmNotification: Order ( ' + orderId + ' ) canceled via case-management REJECT');
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

// APM (Unified Checkout) Notifications
//
// Architecture: the UC API *response* (handled inline at checkout) is the
// primary source of truth for order placement and confirmation status. This
// webhook is intentionally secondary — it serves two purposes only:
//
//   1. Enrichment: log additional transactional info (final settlement
//      status, risk decisions, network token info) that wasn't in the
//      synchronous response.
//   2. Safety net: if the response handler never reached the order (e.g.
//      browser closed mid-flow), stage the payload under
//      `CybersourceWebhookStaging` so a manual / cron reconciliation can
//      pick it up. The CyberSource retry policy gives us up to 3 deliveries.
//
// Important: the webhook MUST NOT downgrade an already-confirmed order back
// to NOTCONFIRMED. A late-arriving AUTHORIZED_PENDING_REVIEW for an order the
// response already confirmed is normal (review can clear after auth).
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

        // Enrichment logging — additional transactional info beyond what the
        // synchronous UC response carried. Keep this lightweight; deeper
        // persistence (e.g. order custom attrs) is left to merchant overrides.
        var enrichment = {
            orderId: orderId,
            status: details && details.status,
            id: details && details.id,
            reconciliationId: details && details.reconciliationId,
            riskDecision: details && details.riskInformation && details.riskInformation.providers
                ? details.riskInformation.providers.decision : undefined,
            networkTokenState: details && details.tokenInformation && details.tokenInformation.networkTokenOption
                ? details.tokenInformation.networkTokenOption.state : undefined
        };
        Logger.info('paymentNotification enrichment for ' + orderId + ': ' + JSON.stringify(enrichment));

        Transaction.wrap(function () {
            // Response is primary for confirmation status. Only *promote* an
            // unconfirmed order to CONFIRMED here as a safety net; never
            // demote a confirmed order back to NOTCONFIRMED.
            var currentStatus = order.getConfirmationStatus();
            if (currentStatus !== order.CONFIRMATION_STATUS_CONFIRMED &&
                ['COMPLETED', 'SETTLED', 'AUTHORIZED'].indexOf(details.status) > -1) {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                Logger.info('paymentNotification: Promoted order ' + orderId + ' to CONFIRMED via webhook safety net (response handler must have missed it).');
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
