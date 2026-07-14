var server = require('server');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Encoding = require('dw/crypto/Encoding');
var Mac = require('dw/crypto/Mac');
var Bytes = require('dw/util/Bytes');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger');
var OrderMgr = require('dw/order/OrderMgr');
var configObject = require('*/cartridge/configuration/index');
var secureResponseHelper = require('*/cartridge/scripts/helpers/secureResponseHelper');


/**
 * Modular decryption function using native platform APIs
 */
function decryptMLEPayload(jweString) {
    if (!jweString) return null;
    var JWE = require('dw/crypto/JWE');
    var KeyRef = require('dw/crypto/KeyRef');

    // Resolve the egress P12 alias from the cartridge configuration (site preference
    // VisaAcceptance_EgressCertificateAlias, surfaced as configObject.egressMleCertificateAlias).
    // The default lives in the site-preference default-value, so no default is hardcoded here.
    var alias = configObject.egressMleCertificateAlias;


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
                Logger.error('decryptMLEPayload: unexpected JWE algorithms — alg=' + header.alg + ', enc=' + header.enc + '. Expected RSA-OAEP-256 + A256GCM per Visa Acceptance webhook spec.');
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
        // Header format: t=<timestamp>;keyId=<keyId>;sig=<hmac-sha256-base64>
        var signatureParts = digitalSignature.split(';');
        if (signatureParts.length < 3) return false;
        // Use slice(1).join('=') to preserve any '=' characters in the value (base64 padding in sig).
        var ts = signatureParts[0].split('=').slice(1).join('=');
        var keyId = signatureParts[1].split('=').slice(1).join('=');
        var s = signatureParts[2].split('=').slice(1).join('=');
        if (Math.abs(Date.now() - parseInt(ts)) > 300000) return false;

        // Fetch the signing key named by the header's keyId. Each key minted by the Webhook Manager is
        // stored as a VisaAcceptanceWebhookSecurityKey record keyed by keyId — that record is the ONLY
        // source of key material (globalConfiguration keeps just the active keyId, not the secret). If it
        // is missing (metadata type not imported, or no record for this keyId) validation fails closed:
        // accepting an unverifiable notification would be a security hole, and there is no legacy key to
        // fall back to.
        var securityKey = '';
        var keyObj = null;
        if (keyId) {
            try {
                keyObj = CustomObjectMgr.getCustomObject('VisaAcceptanceWebhookSecurityKey', keyId);
            } catch (typeErr) {
                // VisaAcceptanceWebhookSecurityKey type not yet imported to sandbox — fail closed below.
                Logger.warn('validateSignature: VisaAcceptanceWebhookSecurityKey type not found (metadata not imported) for ' + customObjectKey + '; rejecting.');
            }
        }
        if (keyObj && keyObj.custom.Key) {
            securityKey = keyObj.custom.Key;
        } else {
            if (keyId) {
                Logger.error('validateSignature [' + customObjectKey + ']: no VisaAcceptanceWebhookSecurityKey record for keyId "' + keyId + '".');
            } else {
                Logger.error('validateSignature [' + customObjectKey + ']: v-c-signature header missing keyId segment.');
            }
            return false;
        }
        if (!securityKey) return false;

        var hmac = new Mac('HmacSHA256');
        var secret = Encoding.fromBase64(securityKey);

        // Visa Acceptance signs `{timestamp}.{raw_body}`.
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

function extractWebhookEventType(payload) {
    if (!payload) return null;
    if (payload.eventType) return payload.eventType;
    if (payload.payload && payload.payload.eventType) return payload.payload.eventType;
    if (payload.payload && payload.payload.length && payload.payload[0]) return payload.payload[0].eventType;
    return null;
}

function extractApmPaymentDetails(payload) {
    if (!payload) return {};

    var apmPayload = payload.payload;
    if (apmPayload) {
        if (apmPayload.transactionResult && apmPayload.transactionResult.details) {
            return apmPayload.transactionResult.details;
        }
        if (apmPayload.data) {
            return apmPayload.data;
        }
        if (apmPayload.length && apmPayload[0]) {
            if (apmPayload[0].data) {
                return apmPayload[0].data;
            }
            if (apmPayload[0].transactionResult && apmPayload[0].transactionResult.details) {
                return apmPayload[0].transactionResult.details;
            }
            return apmPayload[0];
        }
        return apmPayload;
    }

    return payload;
}

function getApmClientReferenceCode(apmDetails) {
    return apmDetails && apmDetails.clientReferenceInformation
        ? apmDetails.clientReferenceInformation.code
        : null;
}

function getApmReconciliationId(apmDetails) {
    if (!apmDetails) return null;
    var reconciliationId = apmDetails.reconciliationId
        || (apmDetails.clientReferenceInformation ? apmDetails.clientReferenceInformation.reconciliationId : null);
    return reconciliationId ? String(reconciliationId) : null;
}

function getApmTransactionId(apmDetails) {
    return apmDetails && apmDetails.id ? String(apmDetails.id) : null;
}

function orderMatchesReconciliationId(order, reconciliationId) {
    if (!order || !reconciliationId) return false;
    var pis = order.getPaymentInstruments().toArray();
    for (var i = 0; i < pis.length; i++) {
        var pt = pis[i].paymentTransaction;
        if (!pt) continue; // eslint-disable-line no-continue
        var matchesTxn = pt.transactionID === reconciliationId;
        var matchesRecon = ('reconciliationId' in pt.custom) && pt.custom.reconciliationId === reconciliationId;
        if (matchesTxn || matchesRecon) return true;
    }
    return false;
}

/**
 * Locate the order for an APM (payments.payments.updated) webhook by the stored transaction id or
 * custom reconciliationId. The default scan stays scoped to NOTCONFIRMED orders; late terminal
 * failures can opt into a bounded active-order scan so already-confirmed APM orders can be failed.
 *
 * @param {string} reconciliationId APM reconciliationId or transaction id
 * @param {boolean} includeConfirmed also scan active confirmed orders for late failures
 * @returns {dw.order.Order} the matching order, or null
 */
function findOrderByReconciliationId(reconciliationId, includeConfirmed) {
    if (!reconciliationId) return null;
    var Order = require('dw/order/Order');
    var orders = includeConfirmed
        ? OrderMgr.searchOrders(
            'status != {0} AND status != {1}',
            'creationDate desc',
            Order.ORDER_STATUS_FAILED, Order.ORDER_STATUS_CANCELLED
        )
        : OrderMgr.searchOrders(
            'confirmationStatus = {0} AND status != {1} AND status != {2}',
            'creationDate desc',
            Order.CONFIRMATION_STATUS_NOTCONFIRMED, Order.ORDER_STATUS_FAILED, Order.ORDER_STATUS_CANCELLED
        );
    var inspected = 0;
    try {
        while (orders.hasNext()) {
            inspected++;
            if (includeConfirmed && inspected > 500) {
                Logger.warn('findOrderByReconciliationId: stopped active-order scan after 500 orders for ' +
                    'reconciliationId ' + reconciliationId + '.');
                break;
            }
            var order = orders.next();
            if (orderMatchesReconciliationId(order, reconciliationId)) return order;
        }
    } finally {
        orders.close();
    }
    return null;
}

function findOrderForApmUpdate(reconciliationId, orderId, includeConfirmed) {
    if (orderId) {
        var order = OrderMgr.getOrder(orderId);
        if (order && (!reconciliationId || orderMatchesReconciliationId(order, reconciliationId))) {
            return order;
        }
        if (order && reconciliationId) {
            Logger.warn('apmNotification: order ' + orderId + ' did not match reconciliationId ' +
                reconciliationId + '; falling back to reconciliation scan.');
        }
    }
    return findOrderByReconciliationId(reconciliationId, includeConfirmed);
}

// A notification can arrive before its order finishes committing (a race), so on order-not-found we
// ask the gateway to retry (non-2xx) for the first few attempts. Once retryNumber reaches this
// threshold we log order-not-found and ack 200 — the subscription retryPolicy has deactivateFlag=true,
// so continuing to fail would suspend the webhook. 2 => retry on the initial delivery and the 1st
// retry, give up on the 2nd retry.
var MAX_ORDER_NOT_FOUND_RETRIES = 2;

/**
 * Respond to an order-not-found webhook: ask the gateway to retry until retryNumber reaches
 * MAX_ORDER_NOT_FOUND_RETRIES, then ack 200 so the subscription is not suspended.
 *
 * @param {Object} payload decoded webhook payload (carries retryNumber)
 * @param {Object} res response object
 * @param {Function} next route next()
 * @param {string} context log label (e.g. 'paymentNotification', 'apmNotification')
 * @param {string} orderRef order number / matching id we could not resolve (for logging)
 * @returns {void}
 */
function respondOrderNotFound(payload, res, next, context, orderRef) {
    var retryNumber = (payload && payload.retryNumber !== undefined && payload.retryNumber !== null)
        ? parseInt(payload.retryNumber, 10) : 0;
    if (isNaN(retryNumber)) retryNumber = 0;

    if (retryNumber < MAX_ORDER_NOT_FOUND_RETRIES) {
        Logger.info(context + ': order ' + orderRef + ' not found (retry ' + retryNumber +
            '); asking gateway to retry.');
        res.setStatusCode(503);
        secureResponseHelper.secureJsonResponse(res, { success: false, message: 'Order not found, retrying...' });
    } else {
        Logger.warn(context + ': order ' + orderRef + ' not found after ' + retryNumber +
            ' retries; acknowledging to keep the subscription active.');
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: true });
    }
    return next();
}

/**
 * Handle an Alternative Payment Methods status update (payments.payments.updated) - e.g. a PPRO
 * bank transfer, eCheck, or BNPL payment moving from PENDING to a terminal state. Terminal paid
 * statuses confirm and mark the order PAID; auth-only success confirms and leaves payment NOT_PAID
 * for later capture; terminal failures fail the order. Best-effort: always ack so Visa Acceptance
 * does not keep retrying a notification we cannot act on.
 *
 * @param {Object} payload decoded webhook payload
 * @param {Object} res response object
 * @param {Function} next route next()
 * @returns {void}
 */
function handleApmPaymentUpdate(payload, res, next) {
    var apm = extractApmPaymentDetails(payload);
    var reconciliationId = getApmReconciliationId(apm);
    var transactionId = getApmTransactionId(apm);
    var matchingId = reconciliationId || transactionId;
    var clientReferenceCode = getApmClientReferenceCode(apm);
    var status = apm && apm.status ? String(apm.status).toUpperCase() : '';
    if (!matchingId && !clientReferenceCode) {
        Logger.error('apmNotification: missing reconciliationId/id/clientReferenceInformation.code; ' +
            'cannot match an order.');
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: false });
        return next();
    }

    var order = null;

    // The APM notification frequently omits clientReferenceInformation.code (e.g. Klarna, Cellulant),
    // and its payment id may differ from the auth transactionID stored on the order, so the local scan
    // can miss the order. Ask the gateway: GET the transaction details, which authoritatively carry the
    // SFCC order number as clientReferenceInformation.code. That id is the authoritative link for this
    // exact transaction, so resolve the order directly from it (no reconciliationId cross-check).
    if (!clientReferenceCode && transactionId) {
        try {
            var apmTransactionDetails = require('*/cartridge/scripts/http/transactionDetails');
            clientReferenceCode = apmTransactionDetails.getClientReferenceCode(transactionId);
            if (clientReferenceCode) {
                order = OrderMgr.getOrder(clientReferenceCode);
                Logger.info('apmNotification: resolved order ' + clientReferenceCode +
                    ' from gateway transaction details for transaction id ' + transactionId + '.');
            } else {
                Logger.warn('apmNotification: gateway transaction details had no order number for ' +
                    'transaction id ' + transactionId + '.');
            }
        } catch (lookupErr) {
            Logger.error('apmNotification: gateway transaction-details lookup failed for id ' +
                transactionId + ': ' + (lookupErr && lookupErr.message ? lookupErr.message : lookupErr));
        }
    }

    // Terminal statuses the alternativePaymentMethods (payments.payments.updated) notification actually
    // sends, per the Cybersource APM docs — matched exactly, not by a loose superset:
    //   SETTLED   (bank transfer / Tink) and COMPLETED (eCheck) => payment complete, mark PAID.
    //   AUTHORIZED (bank transfer / Tink) => auth-only success; confirm but leave NOT_PAID for capture.
    //   FAILED / ABANDONED => terminal failure (a decline arrives as FAILED; DECLINED is only the
    //       response message, never the status value).
    // Everything else the endpoint can carry — PENDING (submitted), TRANSMITTED (eCheck in flight to the
    // ODFI), AUTH-REVERSED, REFUNDED — is non-terminal here and makes no order-state change.
    var isPaid = status === 'SETTLED' || status === 'COMPLETED';
    var isAuth = status === 'AUTHORIZED';
    var isFailed = status === 'FAILED' || status === 'ABANDONED';
    var includeConfirmed = isFailed;
    if (!order) {
        order = findOrderForApmUpdate(matchingId, clientReferenceCode, includeConfirmed);
    }
    if (!order) {
        return respondOrderNotFound(payload, res, next, 'apmNotification',
            (clientReferenceCode || matchingId) + ' (status ' + status + ')');
    }

    var orderId = order.orderNo;
    var CardHelper = require('*/cartridge/scripts/helpers/CardHelper');
    var apmStatusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
    var apmPaymentInstrument = CardHelper.getNonGCPaymemtInstument(order);
    Transaction.wrap(function () {
        // Reflect the APM notification's gateway status in BM (Visa Acceptance Transaction
        // Status) for every outcome, so a settlement/decline updates the value set at auth time.
        if (apmPaymentInstrument && apmPaymentInstrument.paymentTransaction && status) {
            apmPaymentInstrument.paymentTransaction.custom.cybsTransactionStatus =
                apmStatusHelper.formatTransactionStatus(status);
        }
        if (isPaid) {
            if (order.getConfirmationStatus() !== order.CONFIRMATION_STATUS_CONFIRMED) {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
            }
            order.setPaymentStatus(order.PAYMENT_STATUS_PAID);
            Logger.info('apmNotification: Order ( ' + orderId + ' ) confirmed + marked PAID on APM ' +
                status + ' (reconciliationId/id ' + matchingId + ').');
        } else if (isAuth) {
            if (order.getConfirmationStatus() !== order.CONFIRMATION_STATUS_CONFIRMED) {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
            }
            order.setPaymentStatus(order.PAYMENT_STATUS_NOTPAID);
            Logger.info('apmNotification: Order ( ' + orderId + ' ) confirmed on APM ' + status +
                ' and left NOT_PAID pending capture (reconciliationId/id ' + matchingId + ').');
        } else if (isFailed) {
            // failOrder is only legal from CREATED. A late/out-of-order terminal-failure event
            // (a FAILED/ABANDONED delivered after a SETTLED/COMPLETED that already confirmed + PAID
            // the order) must NOT fail an order the customer has already paid for, so guard on status
            // and leave an already placed/failed/cancelled order alone.
            var Order = require('dw/order/Order');
            if (order.getStatus().getValue() === Order.ORDER_STATUS_CREATED) {
                OrderMgr.failOrder(order, false);
                Logger.info('apmNotification: Order ( ' + orderId + ' ) failed on APM ' + status +
                    ' (reconciliationId/id ' + matchingId + ').');
            } else {
                Logger.warn('apmNotification: Order ( ' + orderId + ' ) APM ' + status +
                    ' is terminal-failure but order status is ' + order.getStatus().getValue() +
                    ' (not CREATED); skipping failOrder to avoid failing an already placed/paid order' +
                    ' (reconciliationId/id ' + matchingId + ').');
            }
        } else {
            Logger.info('apmNotification: Order ( ' + orderId + ' ) APM status ' + status +
                ' is non-terminal; no order change (reconciliationId/id ' + matchingId + ').');
        }
    });

    res.setStatusCode(200);
    secureResponseHelper.secureJsonResponse(res, { success: true });
    return next();
}

function handleDmNotification(req, res, next) {
    if (req.httpMethod === 'GET') {
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: true });
        return next();
    }
    if (!validateSignature(req, 'fraudManagement')) {
        res.setStatusCode(401);
        secureResponseHelper.secureJsonResponse(res, { success: false });
        return next();
    }

    try {
        var payload = getDecryptedPayload(req.body);
        if (!payload) throw new Error('Decrypted payload is empty');

        // Normalize the DM/FM payload to its detail object. Case-management notifications nest the
        // data under payload.payload.data (an object); other shapes use transactionResult.details
        // or an array entry.
        var details = (payload.payload && payload.payload.transactionResult) ? payload.payload.transactionResult.details :
            (payload.payload && payload.payload.length ? payload.payload[0].data :
                (payload.payload && payload.payload.data ? payload.payload.data : payload));

        // The case-management payload carries the SFCC order number as referenceNumber (the merchant
        // reference number); other shapes use clientReferenceInformation.code. Prefer the latter, fall
        // back to referenceNumber so accept/reject and capture all resolve the order.
        var orderId = (details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null)
            || (details ? details.referenceNumber : null);
        if (!orderId) throw new Error('Missing Order ID');

        var order = OrderMgr.getOrder(orderId);
        if (!order) {
            return respondOrderNotFound(payload, res, next, 'dmNotification', orderId);
        }

        var reversal = null;
        Transaction.wrap(function () {
            var eventType = payload.eventType || (payload.payload && payload.payload[0] ? payload.payload[0].eventType : null);
            if (eventType === 'risk.casemanagement.decision.accept') {
                // Replicates DMOrderStatusUpdate.js cron behavior on ACCEPT.
                OrderMgr.placeOrder(order);
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                Logger.info('dmNotification: Order ( ' + orderId + ' ) successfully placed via case-management ACCEPT');
            } else if (eventType === 'risk.casemanagement.decision.reject') {
                // Replicates DMOrderStatusUpdate.js cron behavior on REJECT.
                // Case-management decisions carry the reviewer's reason in notes[0].comment
                // (no reviewerComments field); fall back to it so the cancel reason is captured.
                var reviewerComment = (details && details.riskInformation && details.riskInformation.reviewerComments)
                    || (details && details.reviewerComments)
                    || (details && Array.isArray(details.notes) && details.notes.length ? details.notes[0].comment : '')
                    || '';
                // Capture the authorization transaction id (set at auth time) BEFORE failing the
                // order, so the auth-only hold can be reversed once the transaction commits.
                var pis = order.getPaymentInstruments().toArray();
                for (var pIdx = 0; pIdx < pis.length; pIdx++) {
                    if (pis[pIdx].paymentTransaction && pis[pIdx].paymentTransaction.transactionID) {
                        reversal = {
                            requestId: pis[pIdx].paymentTransaction.transactionID,
                            total: order.totalGrossPrice.value,
                            currency: order.currencyCode
                        };
                        break;
                    }
                }
                OrderMgr.failOrder(order, false);
                order.cancelDescription = reviewerComment;
                Logger.info('dmNotification: Order ( ' + orderId + ' ) canceled via case-management REJECT');
            }
        });

        // Capture handling: when the merchant captures in EBC, the case-management notification
        // includes an _embedded.capture link but no captured amount. Fetch the amount via the
        // transaction-details API and reflect Captured / Partially Captured + AmountPaid + paymentStatus.
        var capture = details && details._embedded ? details._embedded.capture : null;
        if (capture) {
            try {
                var captureHref = capture._links && capture._links.self ? capture._links.self.href : null;
                var captureId = captureHref ? captureHref.substring(captureHref.lastIndexOf('/') + 1) : null;
                if (captureId) {
                    var dmStatusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
                    var dmTransactionDetails = require('*/cartridge/scripts/http/transactionDetails');
                    var captureOutcome = dmStatusHelper.applyTransactionOutcome({
                        eventType: payload.eventType,
                        details: details,
                        transactionId: captureId,
                        order: order,
                        fetchCapturedAmount: dmTransactionDetails.getCapturedAmount
                    });
                    Logger.info('dmNotification: capture handled for order ( ' + orderId + ' ) captureId=' + captureId + ' -> status=' + captureOutcome.status + ' (applied=' + captureOutcome.applied + ')');
                } else {
                    Logger.error('dmNotification: capture present for order ( ' + orderId + ' ) but no capture id in href; cannot fetch amount.');
                }
            } catch (captureErr) {
                Logger.error('dmNotification: capture handling failed for order ( ' + orderId + ' ): ' + captureErr.message);
            }
        }

        // Reviewed orders are auth-only (capture is deferred until ACCEPT), so a REJECT must
        // release the authorization hold. The gateway call is made outside the DB transaction and
        // is best-effort — if the auth was already reversed/expired, log it and still ack the
        // webhook so Visa Acceptance does not keep retrying.
        if (reversal) {
            try {
                require('~/cartridge/scripts/http/authReversal').httpAuthReversal(reversal.requestId, orderId, reversal.total, reversal.currency);
                Logger.info('dmNotification: auth reversal requested for rejected order ( ' + orderId + ' ), requestId ' + reversal.requestId);
            } catch (revErr) {
                Logger.error('dmNotification: auth reversal failed for rejected order ( ' + orderId + ' ): ' + (revErr && revErr.message ? revErr.message : revErr));
            }
        }

        
        
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: true });
    } catch (e) {
        Logger.error('dmNotification error: ' + e.message);
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: false });
    }
    return next();
}

// DM Notifications
server.use('dmNotification', handleDmNotification);
server.use('novusDmNotification', handleDmNotification);
// Network-token lifecycle (tokenUpdate). This is the callback endpoint registered by
// networkTokenSubscription.js ('WebhookNotification-tokenUpdate'); there is no order action to take,
// so we simply acknowledge. Kept so a tokenUpdate subscription created at the gateway receives a 200
// rather than a 404 (which the retry/deactivate policy would treat as a delivery failure).
server.use('tokenUpdate', function (req, res, next) {
    secureResponseHelper.secureJsonResponse(res, { success: true });
    return next();
});
// APM (Unified Checkout) Notifications
//
// Architecture: the UC API *response* (handled inline at checkout) is the
// primary source of truth for order placement and confirmation status. This
// webhook is intentionally secondary — it serves two purposes only:
//
//   1. Enrichment: log additional transactional info (final settlement
//      status, risk decisions, network token info) that wasn't in the
//      synchronous response.

server.use('paymentNotification', function (req, res, next) {
    if (req.httpMethod === 'GET') {
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: true });
        return next();
    }

    if (!validateSignature(req, 'unifiedCheckout')) {
        Logger.error('paymentNotification: Signature validation failed');
        res.setStatusCode(401);
        secureResponseHelper.secureJsonResponse(res, { success: false });
        return next();
    }

    try {
        var payload = getDecryptedPayload(req.body);
        if (!payload) throw new Error('Decrypted payload is empty');

        // alternativePaymentMethods rides on this same subscription/endpoint; route it by eventType.
        var apmEventType = extractWebhookEventType(payload);
        if (apmEventType === 'payments.payments.updated') {
            return handleApmPaymentUpdate(payload, res, next);
        }

        var details = (payload.payload && payload.payload.transactionResult) ? payload.payload.transactionResult.details :
            (payload.payload && payload.payload.length ? payload.payload[0].data : payload);

        var orderId = details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null;
        if (!orderId) throw new Error('Missing Order ID');

        var order = OrderMgr.getOrder(orderId);

        if (!order) {
            return respondOrderNotFound(payload, res, next, 'paymentNotification', orderId);
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
        });

        // Reflect the transaction's auth/capture status in BM via the shared status helper.
        try {
            var ucStatusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
            var ucTransactionDetails = require('*/cartridge/scripts/http/transactionDetails');
            ucStatusHelper.applyTransactionOutcome({
                eventType: payload.eventType || 'uc.orders.transactionresults',
                details: details,
                transactionId: details && details.id ? details.id : null,
                order: order,
                fetchCapturedAmount: ucTransactionDetails.getCapturedAmount
            });
        } catch (statusErr) {
            Logger.error('paymentNotification: status helper failed for ' + orderId + ': ' + statusErr.message);
        }

        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: true });
    } catch (e) {
        Logger.error('paymentNotification error: ' + e.message);
        res.setStatusCode(200);
        secureResponseHelper.secureJsonResponse(res, { success: false });
    }
    return next();
});


module.exports = server.exports();
