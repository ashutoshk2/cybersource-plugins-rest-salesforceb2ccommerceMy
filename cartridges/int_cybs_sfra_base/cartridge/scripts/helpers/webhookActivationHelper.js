'use strict';

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var cybersourceRestApi = require('../../apiClient/index');
var Logger = require('dw/system/Logger').getLogger('cybs_webhooks', 'webhookActivationHelper');

function activateWebhooks() {
    try {
        var configObject = require('../../configuration/index');
        var apiClient = cybersourceRestApi.ApiClient.instance;
        apiClient.setConfiguration(configObject);

        var webhooksToActivate = [
            { type: 'CyberSource Webhook Subscription', id: 'fraudManagement' },
            { type: 'CyberSource Webhook Subscription', id: 'unifiedCheckout' }
        ];
        
        webhooksToActivate.forEach(function(item) {
            var obj = CustomObjectMgr.getCustomObject(item.type, item.id);
            var webhookId = obj ? obj.custom[item.keyField || 'WebhookId'] : null;
            
            if (webhookId) {
                apiClient.callApi('/notification-subscriptions/v2/webhooks/' + webhookId + '/status', 'PUT', {}, {}, {}, {}, { status: 'ACTIVE' }, [], ['application/json;charset=utf-8'], ['application/json;charset=utf-8'], {}, function(data, error) {
                    if (error) {
                        Logger.error('Failed to activate webhook ' + item.id + ' (' + webhookId + '): ' + error);
                    } else {
                        Logger.debug('Successfully activated webhook ' + item.id + ' (' + webhookId + ')');
                    }
                });
            }
        });
    } catch (e) {
        Logger.error('Exception in activateWebhooks: ' + e.message);
    }
}

module.exports = {
    activateWebhooks: activateWebhooks
};
