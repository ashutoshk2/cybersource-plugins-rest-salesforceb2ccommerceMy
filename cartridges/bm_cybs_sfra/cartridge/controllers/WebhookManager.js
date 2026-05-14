'use strict';

var server = require('server');
var WebhookModel = require('~/cartridge/models/webhookModel');

server.get('Show', server.middleware.https, function (req, res, next) {
    var model = new WebhookModel();
    var viewData = model.getViewData();
    viewData.actionUrl = require('dw/web/URLUtils').url('WebhookManager-Save').toString();
    viewData.success = req.querystring.success === 'true';
    res.render('webhookManager', viewData);
    return next();
});

server.post('Save', server.middleware.https, function (req, res, next) {
    var model = new WebhookModel();
    var action = req.form.action;

    if (req.form.action === 'sync') {
        model.syncWithPreferences();
    } else if (req.form.action === 'advanced') {
        model.updateAdvanced(req.form.webhookBaseUrl, req.form.egressMleAlias);
    }


    res.redirect(require('dw/web/URLUtils').url('WebhookManager-Show', 'success', 'true'));
    return next();
});

module.exports = server.exports();
