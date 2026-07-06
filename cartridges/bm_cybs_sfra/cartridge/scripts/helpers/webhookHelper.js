'use strict';

var Logger = require('dw/system/Logger').getLogger('cybs_webhooks', 'webhookHelper');

/**
 * Compare two event-type lists as unordered sets.
 *
 * @param {Array} a first event-type list
 * @param {Array} b second event-type list
 * @returns {boolean} true when both lists contain exactly the same event types
 */
function eventTypesMatch(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
    }
    for (var i = 0; i < a.length; i++) {
        var found = false;
        for (var j = 0; j < b.length; j++) {
            if (a[i] === b[j]) { found = true; break; }
        }
        if (!found) return false;
    }
    return true;
}

/**
 * Extract the lowercase hostname (no scheme, port, or path) from a URL string.
 *
 * @param {string} url full URL
 * @returns {string} hostname, or '' when not parseable
 */
function extractHost(url) {
    if (!url) return '';
    var s = String(url);
    var scheme = s.indexOf('://');
    if (scheme >= 0) s = s.substring(scheme + 3);
    var slash = s.indexOf('/');
    if (slash >= 0) s = s.substring(0, slash);
    var colon = s.indexOf(':');
    if (colon >= 0) s = s.substring(0, colon);
    return s.toLowerCase();
}

/**
 * True when subscribeProduct should run: subscription missing, host changed, or not yet ACTIVE.
 * PENDING_REVIEW, RESEND, and BLOCKED are excluded — the Visa Acceptance platform groups these as the
 * hands-off set (its health-check job skips them and delivery is aborted while in them). PENDING_REVIEW
 * and RESEND advance on their own (URL validation / retry-queue reprocessing); BLOCKED means a URL was
 * rejected by security and needs the URL approved, not an auto-retry (a PUT status=ACTIVE would just
 * fail). SUSPENDED and INACTIVE are intentionally NOT excluded: both are meant to be (re)activated, and
 * subscribeProduct reactivates an existing same-URL subscription via PUT status=ACTIVE rather than
 * recreating it.
 *
 * @param {Object} sub reconciled subscription ({ webhookId, status, hostMismatch }) or null
 * @returns {boolean} true when subscribeProduct should run for this product
 */
function subscriptionNeedsAction(sub) {
    if (!sub) return true;
    if (sub.hostMismatch) return true;
    return !!(sub.status
        && sub.status !== 'ACTIVE'
        && sub.status !== 'PENDING_REVIEW'
        && sub.status !== 'RESEND'
        && sub.status !== 'BLOCKED');
}

/**
 * Derive the egress MLE public certificate (base64 DER, not PEM) from the .p12 imported in BM under
 * `alias` — the same alias WebhookNotification decrypts with. Must be an RSA keypair. Returns '' on failure.
 *
 * @param {string} alias keystore alias of the merchant .p12 (private key entry)
 * @returns {string} base64-DER X.509 certificate, or '' on failure
 */
function deriveEgressCertificateB64(alias) {
    if (!alias) {
        Logger.error('deriveEgressCertificateB64: no egress alias configured.');
        return '';
    }
    try {
        var CertificateUtils = require('dw/crypto/CertificateUtils');
        var KeyRef = require('dw/crypto/KeyRef');
        var cert = CertificateUtils.getCertificate(new KeyRef(alias));
        if (!cert) {
            Logger.error('deriveEgressCertificateB64: no certificate for alias "' + alias + '".');
            return '';
        }
        var b64 = CertificateUtils.getEncodedCertificate(cert);
        var clean = b64 ? String(b64).replace(/\s+/g, '') : '';
        if (!clean || !/^[A-Za-z0-9+/=]+$/.test(clean)) {
            Logger.error('deriveEgressCertificateB64: getEncodedCertificate returned empty/non-base64 for alias "' + alias + '".');
            return '';
        }
        try {
            Logger.info('deriveEgressCertificateB64: derived egress certificate from alias "' + alias + '" (subject=' + cert.getSubjectDN() + ', serial=' + cert.getSerialNumber() + ', b64len=' + clean.length + ').');
        } catch (logErr) { /* identity logging is best-effort */ }
        return clean;
    } catch (e) {
        Logger.error('deriveEgressCertificateB64 failed for alias "' + alias + '": ' + ((e && e.message) || e) + '. Verify the RSA .p12 is imported under Administration > Operations > Private Keys and Certificates with this exact alias.');
        return '';
    }
}

module.exports = {
    eventTypesMatch: eventTypesMatch,
    extractHost: extractHost,
    subscriptionNeedsAction: subscriptionNeedsAction,
    deriveEgressCertificateB64: deriveEgressCertificateB64
};
