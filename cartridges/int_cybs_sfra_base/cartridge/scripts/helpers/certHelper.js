'use strict';

var CertificateUtils = require('dw/crypto/CertificateUtils');
var KeyRef = require('dw/crypto/KeyRef');
var Logger = require('dw/system/Logger');

/**
 * Extract a single relative distinguished name (RDN) value from a subject DN string.
 *
 * The subject DN is parsed from cert.getSubjectDN(), whose exact string rendering is
 * not contractually guaranteed by the platform. The match is therefore tolerant:
 * case-insensitive, accepts the common labels for the attribute, and treats ',', '/'
 * and '+' as RDN separators (RFC 2253 comma form and the OpenSSL "oneline" slash form).
 *
 * @param {string} subjectDN - the certificate subject distinguished name
 * @param {string[]} labels - acceptable attribute labels for this RDN (e.g. ['CN'])
 * @returns {string} the trimmed RDN value, or '' if not present
 */
function extractRdn(subjectDN, labels) {
    if (!subjectDN) {
        return '';
    }
    // (?:^|[,/+]) - start of string or an RDN separator
    // \s* LABEL \s* = \s* (value) where value runs to the next separator
    var pattern = '(?:^|[,/+])\\s*(?:' + labels.join('|') + ')\\s*=\\s*([^,/+]+)';
    var match = new RegExp(pattern, 'i').exec(subjectDN);
    return match ? match[1].trim() : '';
}

/**
 * Derive the JWT `kid` claim from the P12 private-key entry bound to the given alias.
 * Used for RS256 request signing (ApiClient.getJWTToken).
 *
 * The value CyberSource keys on is the `serialNumber` attribute embedded in the certificate
 * subject DN, e.g. subject = CN=wiproltd, SERIALNUMBER=1776690364461016252465. This is NOT
 * the X.509 certificate serial number (X509Certificate#getSerialNumber()).
 *
 * @param {string} alias - keystore alias of the signing P12 private-key entry
 * @param {string} [expectedMerchantId] - MID expected in the subject CN; warns on mismatch
 * @returns {string} the derived kid (subject DN serialNumber attribute)
 * @throws {Error} if no certificate is bound to the alias or no serialNumber is found
 */
function getKidFromAlias(alias, expectedMerchantId) {
    var cybsLogger = Logger.getLogger('CyberSource', 'certHelper');

    if (!alias) {
        throw new Error('certHelper.getKidFromAlias: no P12 alias provided. Set the P12 private key alias in site preferences.');
    }

    var cert = CertificateUtils.getCertificate(new KeyRef(alias));
    if (!cert) {
        throw new Error('certHelper.getKidFromAlias: no certificate bound to alias "' + alias
            + '". Verify the P12 is imported under Administration > Operations > Private Keys and Certificates with this exact alias.');
    }

    var subjectDN = String(cert.getSubjectDN());
    var serial = extractRdn(subjectDN, ['SERIALNUMBER', 'OID\\.2\\.5\\.4\\.5', '2\\.5\\.4\\.5']);

    if (!serial) {
        cybsLogger.error('certHelper.getKidFromAlias: no serialNumber attribute found in subject DN for alias "{0}" (subject={1}).', alias, subjectDN);
        throw new Error('certHelper.getKidFromAlias: could not derive JWT kid (subject DN serialNumber) from certificate for alias "' + alias + '".');
    }

    // "Filter by MID" guard: confirm the alias resolved to the cert for the expected merchant.
    if (expectedMerchantId) {
        var cn = extractRdn(subjectDN, ['CN']);
        if (cn && cn !== String(expectedMerchantId)) {
            cybsLogger.warn('certHelper.getKidFromAlias: certificate CN "{0}" for alias "{1}" does not match expected merchant id "{2}". Verify the correct P12 alias is configured.', cn, alias, expectedMerchantId);
        }
    }

    cybsLogger.info('certHelper.getKidFromAlias: derived JWT kid from alias "{0}" (kid={1}, subject={2}).', alias, serial, subjectDN);
    return serial;
}

module.exports = {
    getKidFromAlias: getKidFromAlias
};
