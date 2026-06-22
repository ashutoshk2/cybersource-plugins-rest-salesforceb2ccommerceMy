'use strict';

var Mac = require('dw/crypto/Mac');
var Encoding = require('dw/crypto/Encoding');
var Bytes = require('dw/util/Bytes');
var Signature = require('dw/crypto/Signature');
var KeyRef = require('dw/crypto/KeyRef');
var Site = require('dw/system/Site');


/**
 * Generate HMAC-SHA256 signature for data
 * @param {string} data - The data to sign
 * @returns {string} - Base64 encoded HMAC signature
 */
function generateHMAC(data) {
    var mac = new Mac(Mac.HMAC_SHA_256);
    var secret = getHMACSecret();
    var signature = mac.digest(data, secret);
    return Encoding.toBase64(signature);
}

/**
 * Verify HMAC-SHA256 signature using constant-time comparison
 * @param {string} data - The data that was signed
 * @param {string} signature - The signature to verify
 * @returns {boolean} - true if signature is valid
 */
function verifyHMAC(data, signature) {
    var expectedSignature = generateHMAC(data);

    // Constant-time comparison to prevent timing attacks
    if (!signature || signature.length !== expectedSignature.length) {
        return false;
    }

    var result = 0;
    for (var i = 0; i < expectedSignature.length; i++) {
        result |= expectedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
    }

    return result === 0;
}

/**
 * Resolve the P12 alias used for signing (shared by standard and Meta Key flows).
 * @returns {string} - P12 alias
 */
function getP12AliasForHMAC() {
    var configObject = require('../../configuration/index');

    // Both standard and Meta Key flows sign with the same P12 alias.
    if (!configObject.p12PrivateKeyAlias) {
        throw new Error('P12 private key alias is not configured. Please set VisaAcceptance_P12PrivateKeyAlias in site preferences.');
    }

    return configObject.p12PrivateKeyAlias;
}

/**
 * Derive deterministic HMAC key material from the configured P12 private key.
 * @returns {dw.util.Bytes} - HMAC secret bytes
 */
function getHMACSecret() {
    //jwt auth
    //var p12Alias = getP12AliasForHMAC();
    //var signature = new Signature();
    //var keyRef = new KeyRef(p12Alias);
    //var derivationContext = new Bytes('cybs-tax-cookie-hmac-v1', 'UTF-8');
    //return signature.signBytes(derivationContext, keyRef, 'SHA256withRSA');
    
    //http auth
    var currentSite = Site.getCurrent();
    // Reuse the existing CyberSource merchant secret key
    var secret = currentSite.getCustomPreferenceValue('VisaAcceptance_MerchantKeySecret');

    if (!secret) {
        throw new Error('CyberSource Merchant Key Secret not configured. Please set VisaAcceptance_MerchantKeySecret in site preferences.');
    }

    return secret;
}

module.exports = {
    generateHMAC: generateHMAC,
    verifyHMAC: verifyHMAC
};