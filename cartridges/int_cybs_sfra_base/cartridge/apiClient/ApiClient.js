'use strict';
var Bytes = require('dw/util/Bytes');
var Encoding = require('dw/crypto/Encoding');
var Mac = require('dw/crypto/Mac');
var MessageDigest = require('dw/crypto/MessageDigest');
var configObject = require('*/cartridge/configuration/index');
var MerchantConfig = require('./merchantConfig');
var Logger = require('./logger');

var _exports = function () { }

_exports.prototype.createService = function () {
    var PaymentsHttpService = dw.svc.LocalServiceRegistry.createService("PaymentHttpService", {
        createRequest: function (svc, url, headers, method, requestBody) {
            var keys = Object.keys(headers);
            var StringHeaders = "";
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                svc.addHeader(key, headers[key]);
                StringHeaders += key + ":" + headers[key] + "\n";
            }
            svc.URL = url;
            svc.setRequestMethod(method.toUpperCase());
            if (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PATCH' || method.toUpperCase() === 'PUT') {
                if (typeof requestBody === 'string') {
                    return requestBody;
                }
                return JSON.stringify(requestBody);
            }
        },
        parseResponse: function (svc, client) {
            return client.text;
        },
        filterLogMessage: function (msg) {
            // Filter sensitive payment data from logs to comply with PCI-DSS
            if (!msg || typeof msg !== 'string') {
                return msg;
            }

            function filterSensitiveFields(obj) {
                if (!obj || typeof obj !== 'object') {
                    return obj;
                }

                var filtered = Array.isArray(obj) ? [] : {};

                for (var key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        var lowerKey = key.toLowerCase();
                        var value = obj[key];

                        // Mask credit card numbers - keep last 4 digits
                        if (lowerKey === 'number' || lowerKey === 'cardnumber' || lowerKey === 'accountnumber') {
                            if (typeof value === 'string' && value.length >= 13) {
                                filtered[key] = '****' + value.slice(-4);
                            } else {
                                filtered[key] = '****';
                            }
                        }
                        // Completely redact security codes, CVV, CVV2
                        else if (lowerKey === 'securitycode' || lowerKey === 'cvv' || lowerKey === 'cvv2' || lowerKey === 'cvc') {
                            filtered[key] = '***';
                        }
                        // Redact secret keys, passwords, tokens
                        else if (lowerKey.indexOf('secret') !== -1 || lowerKey.indexOf('password') !== -1 ||
                            lowerKey.indexOf('token') !== -1 || lowerKey === 'pin') {
                            filtered[key] = '[REDACTED]';
                        }
                        // Mask authorization signatures
                        else if (lowerKey === 'signature' || lowerKey === 'authorization') {
                            filtered[key] = '[REDACTED]';
                        }
                        // Recursively filter nested objects and arrays
                        else if (typeof value === 'object' && value !== null) {
                            filtered[key] = filterSensitiveFields(value);
                        }
                        // Keep non-sensitive values
                        else {
                            filtered[key] = value;
                        }
                    }
                }

                return filtered;
            }

            function filterSensitiveText(text) {
                var filtered = text;

                // Mask 13-19 digit card numbers (keep last 4)
                filtered = filtered.replace(/\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{3,4})\b/g, function (match) {
                    var digits = match.replace(/[\s-]/g, '');
                    return '****' + digits.slice(-4);
                });

                // Redact CVV/CVV2 patterns (3-4 digits labeled as CVV)
                filtered = filtered.replace(/\b(cvv2?|cvc|security_?code)["\s:=]+(\d{3,4})\b/gi, '$1:***');

                // Redact authorization headers
                filtered = filtered.replace(/(authorization|signature)["\s:=]+[^\s,"}]+/gi, '$1:[REDACTED]');

                return filtered;
            }

            var filteredMsg = msg;

            try {
                // Try to parse as JSON to filter structured data
                var parsedMsg = JSON.parse(msg);
                filteredMsg = JSON.stringify(filterSensitiveFields(parsedMsg));
            } catch (e) {
                // Not JSON, apply regex-based filtering for plain text logs
                filteredMsg = filterSensitiveText(msg);
            }

            return filteredMsg;
        }
    });
    return PaymentsHttpService;
};

_exports.prototype.setConfiguration = function (configObject) {
    this.merchantConfig = new MerchantConfig(configObject);
    this.basePath = this.createService().configuration.credential.getURL();
    this.logger = Logger.getLogger(this);
};

_exports.prototype.addQueryParams = function (url, queryParams) {
    var keys = Object.keys(queryParams);
    if (keys.length > 0) {
        if (url[url.length - 1] === '/') {
            url[url.length - 1] = '?';
        } else {
            url += '?';
        }
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (queryParams[key]) {
                url += key + '=' + queryParams[key];
            }
            if (i < keys.length - 1 && queryParams[keys[i + 1]]) {
                url += '&';
            }
        }
    }
    return url;
}

_exports.prototype.paramToString = function (param) {
    if (param == undefined || param == null) {
        return '';
    }
    if (param instanceof Date) {
        return param.toJSON();
    }
    return param.toString();
}

_exports.prototype.buildUrl = function (path, pathParams, queryParams) {
    if (!path.match(/^\//)) {
        path = '/' + path;
    }
    var url = this.basePath + path;
    var _this = this;
    url = url.replace(/\{([\w-]+)\}/g, function (fullMatch, key) {
        var value;

        if (pathParams.hasOwnProperty(key)) {
            value = _this.paramToString(pathParams[key]);
        } else {
            value = fullMatch;
        }

        return encodeURIComponent(value);
    });
    return this.addQueryParams(url, queryParams);
};

_exports.prototype.generateDigest = function (payload) {
    var buffer = new Bytes(payload, 'utf8');
    var messageDigest = new MessageDigest('SHA-256');
    messageDigest.updateBytes(buffer);
    var digest = messageDigest.digest();
    var digestBase64 = Encoding.toBase64(digest);

    return digestBase64;
}

_exports.prototype.base64UrlEncode = function (input) {
    var base64;
    if (typeof input === 'string') {
        base64 = Encoding.toBase64(new Bytes(input, 'UTF-8'));
    } else {
        base64 = Encoding.toBase64(input);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

_exports.prototype.getHttpSignature = function (resource, method, merchantKeyId, requestHost, merchantId, merchantSecretKey, payload) {
    var signatureHeader = "";
    var signatureValue = "";

    // KeyId is the key obtained from EBC
    signatureHeader += "keyid=\"" + merchantKeyId + "\"";

    // Algorithm should be always HmacSHA256 for http signature
    signatureHeader += ", algorithm=\"HmacSHA256\"";

    // Headers - list is choosen based on HTTP method.
    // Digest is not required for GET Method
    if (method === "get" || method === "delete") {
        var headersForGetMethod = "host date request-target v-c-merchant-id";
        signatureHeader += ", headers=\"" + headersForGetMethod + "\"";
    } else if (method === "post" || method === "patch" || method === "put") {
        var headersForPostMethod = "host date request-target digest v-c-merchant-id";
        signatureHeader += ", headers=\"" + headersForPostMethod + "\"";
    }

    var signatureString = 'host: ' + requestHost;

    signatureString += '\ndate: ' + new Date(Date.now()).toUTCString();
    signatureString += '\nrequest-target: ';

    if (method === "get" || method === "delete") {
        var targetUrlForGet = method + " " + resource;
        signatureString += targetUrlForGet + '\n';
    } else if (method === "post" || method === "patch" || method === "put") {
        // Digest for POST call
        var digest = this.generateDigest(payload);

        var targetUrlForPost = method + " " + resource;
        signatureString += targetUrlForPost + '\n';

        signatureString += 'digest: SHA-256=' + digest + '\n';
    }

    signatureString += 'v-c-merchant-id: ' + merchantId;

    var data = new Bytes(signatureString, 'utf8');

    // Decoding scecret key
    var key = Encoding.fromBase64(merchantSecretKey);

    var mac = new Mac("HmacSHA256");
    var digest = mac.digest(data, key);
    signatureValue = Encoding.toBase64(digest);

    signatureHeader += ", signature=\"" + signatureValue + "\"";

    return signatureHeader;
}


_exports.prototype.getJWTToken = function (resource, method, merchantId, digest, requestHost) {
    var Signature = require('dw/crypto/Signature');
    var KeyRef = require('dw/crypto/KeyRef');
    var UUIDUtils = require('dw/util/UUIDUtils');

    // Read the P12 signing alias from BM site preferences.
    // Use Meta Key credentials when Meta Key is enabled.
    var cybsLogger = require('dw/system/Logger').getLogger('CyberSource', 'ApiClient');
    var certHelper = require('*/cartridge/scripts/helpers/certHelper');
    var p12PrivateKeyAlias;
    // The MID expected in the signing cert's subject CN. For meta keys this is the
    // portfolio owner (the JWT iss), not the transacting child MID.
    var expectedMid;
    if (configObject.metaKeyEnabled) {
        cybsLogger.info('Meta Key authentication is enabled. Using Meta Key credentials for merchant {0}.', merchantId);
        var missingFields = [];
        if (!configObject.p12PrivateKeyAlias) { missingFields.push('p12PrivateKeyAlias'); }
        if (!configObject.metaKeyMerchantId) { missingFields.push('metaKeyMerchantId'); }
        if (missingFields.length > 0) {
            cybsLogger.error('Meta Key is enabled but required fields are missing: {0}. Check Business Manager site preferences.', missingFields.join(', '));
        }
        // Meta Key reuses the standard P12 signing alias; only the issuer MID differs.
        p12PrivateKeyAlias = configObject.p12PrivateKeyAlias;
        expectedMid = configObject.metaKeyMerchantId;
    } else {
        p12PrivateKeyAlias = configObject.p12PrivateKeyAlias;
        expectedMid = merchantId;
    }

    // Derive the kid (subject DN serialNumber) from the cert bound to the signing alias,
    // rather than reading it from a separate site preference.
    var p12KeyId = certHelper.getKidFromAlias(p12PrivateKeyAlias, expectedMid);

    var currentTimestamp = Math.floor(Date.now() / 1000);

    // JWS Header Claims - only alg, typ, kid per spec
    var header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: p12KeyId,
        'v-c-merchant-id': merchantId
    };

    // JWS Body Claims - JWT v2 (field order matches working reference)
    var jwtPayload = {};
    if (digest) {
        jwtPayload.digest = digest;
        jwtPayload.digestAlgorithm = 'SHA-256';
    }
    jwtPayload.exp = currentTimestamp + 120;
    jwtPayload.iat = currentTimestamp;
    // For meta keys, iss must be the portfolio owner (P12 owner), not the transacting child MID
    jwtPayload.iss = (configObject.metaKeyEnabled && configObject.metaKeyMerchantId) ? configObject.metaKeyMerchantId : merchantId;
    jwtPayload.jti = UUIDUtils.createUUID();
    jwtPayload['request-method'] = method;
    jwtPayload['request-resource-path'] = resource;
    jwtPayload['request-host'] = requestHost;
    // jwtPayload['v-c-jwt-version'] = '2';
    jwtPayload['v-c-merchant-id'] = merchantId;

    // Base64URL encode header and payload (Step 4)
    var encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    var encodedPayload = this.base64UrlEncode(JSON.stringify(jwtPayload));

    // Create signing input and sign with private key from SFCC keystore
    var signingInput = encodedHeader + '.' + encodedPayload;

    // Sign with private key from SFCC keystore (P12 uploaded to BM > Private Keys and Certificates)
    var keyRef = new KeyRef(p12PrivateKeyAlias);
    var sig = new Signature();
    var signatureBytes = sig.signBytes(new Bytes(signingInput, 'UTF-8'), keyRef, 'SHA256withRSA');
    var encodedSignature = this.base64UrlEncode(signatureBytes);

    return signingInput + '.' + encodedSignature;
}
_exports.prototype.normalizeParams = function (params) {
    var newParams = {};
    for (var key in params) {
        if (params.hasOwnProperty(key) && params[key] != undefined && params[key] != null) {
            var value = params[key];
            if (Array.isArray(value)) {
                newParams[key] = value;
            } else {
                newParams[key] = this.paramToString(value);
            }
        }
    }
    return newParams;
}

_exports.prototype.callApi = function (path, httpMethod, pathParams, queryParams, headerParams, formParams, bodyParam, authNames, contentTypes, accepts, returnType, callback, isMLESupportedByCybsForApi) {
    // var hostAndPath = this.basePath.substr(this.basePath.indexOf("//") + 2);
    // var requestHost = hostAndPath.indexOf('/') > -1 ? hostAndPath.substring(0, hostAndPath.indexOf('/')) : hostAndPath;

    // for http signature auth
     var requestHost = this.basePath.substr(
        this.basePath.indexOf("//") + 2
    );

    var method = httpMethod.toLowerCase();
    var merchantId = this.merchantConfig.getMerchantID();

    // for http signature auth
    var merchantKeyId = this.merchantConfig.getMerchantKeyID();
    var merchantSecretKey = this.merchantConfig.getMerchantsecretKey();

    var payload = "";
    var Constants = require('../apiClient/constants');

    var url = this.buildUrl(path, pathParams, queryParams);

    var resource = url.substr(this.basePath.length);
    var contentType = contentTypes.join(';');
    var acceptType = accepts.join(';');

    var date = new Date(Date.now()).toUTCString();
    if (method === 'post' || method === 'patch' || method === 'put') {
        if (typeof bodyParam === 'string') {
            bodyParam = JSON.parse(bodyParam);
        }

        // UC V1 Sessions API (/uc/v1/sessions) does not support clientReferenceInformation
        // Skip adding partner/solution info for this endpoint per UC V1 API Contract
        var isUcV1SessionsApi = path === '/uc/v1/sessions';

        // adding solution id to all post calls (except UC V1 Sessions which doesn't support it)
        if (!isUcV1SessionsApi) {
            if (!bodyParam.clientReferenceInformation) {
                bodyParam.clientReferenceInformation = {};
            }
            if (path === '/up/v1/capture-contexts') {
                bodyParam.clientReferenceInformation.code = '102';
            } else {
                bodyParam.clientReferenceInformation.applicationName = Constants.APPLICATION_NAME;
                bodyParam.clientReferenceInformation.applicationVersion = Constants.APPLICATION_VERSION;
                bodyParam.clientReferenceInformation.partner = {
                    solutionId: this.merchantConfig.getSolutionId()
                }
            }
        }
        payload = JSON.stringify(bodyParam);

        var isMLEEnabled = configObject.mleEnabled;

        if (isMLEEnabled && isMLESupportedByCybsForApi == true) {
            var encryptPayload = require('*/cartridge/scripts/mle/jweEncrypt.js');
            payload = encryptPayload.getJWE(payload);

        }
        var signature = this.getHttpSignature(resource, method, merchantKeyId, requestHost, merchantId, merchantSecretKey, payload);
        var digest = this.generateDigest(payload);
        digest = "SHA-256=" + digest;
        headerParams['digest'] = digest;
        
        // var jwtToken = this.getJWTToken(resource, method, merchantId, digest, requestHost);
        // headerParams['Authorization'] = 'Bearer ' + jwtToken;
    } else {
        var signature = this.getHttpSignature(resource, method, merchantKeyId, requestHost, merchantId, merchantSecretKey);

        // var jwtToken = this.getJWTToken(resource, method, merchantId, null, requestHost);
        // headerParams['Authorization'] = 'Bearer ' + jwtToken;
    }

    headerParams['v-c-merchant-id'] = merchantId;
    headerParams['date'] = date;
    headerParams['host'] = requestHost;
    headerParams['signature'] = signature; // for http signature auth
    headerParams['User-Agent'] = "Mozilla/5.0"; // for http signature auth
    headerParams['Content-Type'] = contentType;
    headerParams['Accept'] = acceptType;

    // Set header parameters
    var normalizedHeaders = this.normalizeParams(headerParams);

    // Calling service.
    if (method === 'post' || method === 'patch' || method === 'put') {
        var response = this.createService().call(url, normalizedHeaders, method, payload);
    } else {
        var response = this.createService().call(url, normalizedHeaders, method);
    }

    if (response.ok) {
        var responseObj = response.object;
        // These endpoints return JWT strings, not JSON - skip JSON.parse
        if (path === '/microform/v2/sessions' || path === '/up/v1/capture-contexts' || path === '/uc/v1/sessions') {
            callback(responseObj, false, response);
        } else {
            callback(JSON.parse(responseObj), false, response);
        }
    } else {
        callback(response.errorMessage, response.error, response);
    }
};

module.exports = {
    instance: new _exports()
};
