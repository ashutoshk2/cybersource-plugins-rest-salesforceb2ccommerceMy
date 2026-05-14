'use strict';

var configObject = require('int_cybs_sfra_base/cartridge/configuration/index');
var apiClient = require('int_cybs_sfra_base/cartridge/apiClient/ApiClient');
var MerchantConfig = require('int_cybs_sfra_base/cartridge/apiClient/merchantConfig');
var Transaction = require('dw/system/Transaction');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var URLUtils = require('dw/web/URLUtils');
var URLAction = require('dw/web/URLAction');
var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('cybs_webhooks', 'webhookSubscription');

var merchantId = new MerchantConfig(configObject).getMerchantID();
apiClient.instance.setConfiguration(configObject);

var CUSTOM_OBJECT_TYPE = 'CyberSource Webhook Subscription';

var WEBHOOK_CONFIGS = {
    fraudManagement: {
        name: 'Fraud Management',
        notificationEndpoint: 'WebhookNotification-dmNotification',
        products: [
            {
                productId: 'decisionManager',
                eventTypes: ['risk.casemanagement.decision.accept', 'risk.casemanagement.decision.reject']
            },
            {
                productId: 'fraudManagementEssentials',
                eventTypes: ['risk.profile.decision.review', 'risk.casemanagement.decision.accept', 'risk.casemanagement.decision.reject']
            }
        ]
    },
    alternativePaymentMethods: {
        name: 'UC Webhook Events',
        description: 'UC Events Simulation',
        notificationEndpoint: 'WebhookNotification-paymentNotification',
        products: [{ productId: 'unifiedCheckout', eventTypes: ['uc.orders.transactionresults'] }]
    },
    tokenManagement: {
        name: 'Token Management',
        notificationEndpoint: 'WebhookNotification-tokenUpdate',
        products: [{ productId: 'tokenManagement', eventTypes: ['tms.networktoken.updated', 'tms.networktoken.provisioned'] }]
    }
};

function retrieveWebhooks(productId, callback) {
    var queryParams = { organizationId: merchantId, productId: productId };
    apiClient.instance.callApi('/notification-subscriptions/v1/webhooks', 'GET', {}, queryParams, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, callback);
}

function createSecurityKey(callback) {
    var postBody = {
        clientRequestAction: 'CREATE',
        keyInformation: { provider: 'nrtd', tenant: merchantId, keyType: 'sharedSecret', organizationId: merchantId }
    };
    apiClient.instance.callApi('/kms/egress/v2/keys-sym', 'POST', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/hal+json;charset=utf-8'], {}, callback);
}

function createSubscription(config, webhookUrl, callback) {
    var product = config.products[0];
    var postBody = {
        name: config.name,
        description: config.description || ('CyberSource Webhook for ' + config.name),
        organizationId: merchantId,
        webhookUrl: webhookUrl,
        healthCheckUrl: webhookUrl,
        notificationScope: 'SELF',
        productId: product.productId,
        eventTypes: product.eventTypes,
        retryPolicy: {
            algorithm: 'ARITHMETIC',
            firstRetry: 1,
            interval: 1,
            numberOfRetries: 3,
            deactivateFlag: 'false',
            repeatSequenceCount: 0,
            repeatSequenceWaitTime: 0
        },
        securityPolicy: {
            securityType: 'KEY',
            proxyType: 'external'
        }
    };
    apiClient.instance.callApi('/notification-subscriptions/v1/webhooks', 'POST', {}, {}, {}, {}, postBody, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, callback);
}

function deleteSubscription(webhookId, callback) {
    apiClient.instance.callApi('/notification-subscriptions/v1/webhooks/{webhookId}', 'DELETE', { webhookId: webhookId }, {}, {}, {}, null, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, callback);
}

function subscribeProduct(configId) {
    var config = WEBHOOK_CONFIGS[configId];
    var site = Site.getCurrent();
    var customBaseUrl = site.getCustomPreferenceValue('Cybersource_Webhook_Base_URL');
    var webhookUrl = customBaseUrl ? (customBaseUrl.replace(/\/$/, '') + '/' + config.notificationEndpoint) : URLUtils.https(new URLAction(config.notificationEndpoint, site.ID)).toString();

    var existingObj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    if (existingObj && existingObj.custom.WebhookId && existingObj.custom.WebhookUrl === webhookUrl) return { success: true, alreadyExists: true };
    if (existingObj && existingObj.custom.WebhookId) deleteSubscription(existingObj.custom.WebhookId, function () {});

    var securityKey = '';
    createSecurityKey(function (data, error) { if (!error && data.status === 'SUCCESS') securityKey = data.keyInformation.key; });
    if (!securityKey) return { success: false, error: 'KEY_ERROR' };

    var webhookId = '';
    createSubscription(config, webhookUrl, function (data, error) { if (!error && data.webhookId) webhookId = data.webhookId; });
    if (!webhookId) return { success: false, error: 'API_ERROR' };

    Transaction.wrap(function () {
        var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId) || CustomObjectMgr.createCustomObject(CUSTOM_OBJECT_TYPE, configId);
        obj.custom.WebhookId = webhookId;
        obj.custom.SecurityKey = securityKey;
        obj.custom.WebhookUrl = webhookUrl;
        obj.custom.Status = 'ACTIVE';
    });
    return { success: true, webhookId: webhookId };
}

function unsubscribeProduct(configId) {
    var obj = CustomObjectMgr.getCustomObject(CUSTOM_OBJECT_TYPE, configId);
    if (!obj || !obj.custom.WebhookId) return { success: true, alreadyRemoved: true };
    deleteSubscription(obj.custom.WebhookId, function () {});
    Transaction.wrap(function () { CustomObjectMgr.remove(obj); });
    return { success: true };
}

exports.retrieveWebhooks = retrieveWebhooks;
exports.subscribeFraudManagement = function() { return subscribeProduct('fraudManagement'); };
exports.unsubscribeFraudManagement = function() { return unsubscribeProduct('fraudManagement'); };
exports.subscribeAPM = function() { return subscribeProduct('alternativePaymentMethods'); };
exports.unsubscribeAPM = function() { return unsubscribeProduct('alternativePaymentMethods'); };
exports.subscribeNetworkTokens = function() { return subscribeProduct('tokenManagement'); };
exports.unsubscribeNetworkTokens = function() { return unsubscribeProduct('tokenManagement'); };
