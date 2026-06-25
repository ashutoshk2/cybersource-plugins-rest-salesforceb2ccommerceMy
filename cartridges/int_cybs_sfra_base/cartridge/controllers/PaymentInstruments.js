'use strict';

var server = require('server');
var URLUtils = require('dw/web/URLUtils');
var configObject = require('../configuration/index');
var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var userLoggedIn = require('*/cartridge/scripts/middleware/userLoggedIn');

var page = module.superModule;
server.extend(page);

if (configObject.tokenizationEnabled && configObject.cartridgeEnabled) {
    server.prepend('DeletePayment', userLoggedIn.validateLoggedInAjax, function (req, res, next) {
        var tokenManagement = require('../scripts/http/tokenManagement');
        var mapper = require('~/cartridge/scripts/util/mapper.js');
        var array = require('*/cartridge/scripts/util/array');
        var UUID = req.querystring.UUID;
        var paymentInstruments = req.currentCustomer.wallet.paymentInstruments;
        var paymentToDelete = array.find(paymentInstruments, function (item) {
            return UUID === item.UUID;
        });
        if (paymentToDelete) {
            var paymentToken = paymentToDelete.raw.getCreditCardToken();
            var tokenInformation = mapper.deserializeTokenInformation(paymentToken);
            if (tokenInformation.paymentInstrument.id) {
                // eslint-disable-next-line no-undef
                tokenManagement.httpDeleteCustomerPaymentInstrument(session.getCustomer().getProfile().custom.customerID, tokenInformation.paymentInstrument.id);
            }
        }
        return next();
    });
    server.prepend('List', userLoggedIn.validateLoggedIn, function (req, res, next) {
        var Transaction = require('dw/system/Transaction');
        // eslint-disable-next-line no-undef
        var paymentInstrumentToBeDeleted = session.getCustomer().getProfile().custom.deleteInstrumentId;
        if (paymentInstrumentToBeDeleted.length !== 0) {
            var tokenManagement = require('~/cartridge/scripts/http/tokenManagement.js');
            // eslint-disable-next-line no-undef
            var result = tokenManagement.httpDeleteCustomerPaymentInstrument(session.getCustomer().getProfile().custom.customerID, paymentInstrumentToBeDeleted[0]);
            if (result === true) {
                Transaction.wrap(function () {
                    // eslint-disable-next-line no-undef
                    session.getCustomer().getProfile().custom.deleteInstrumentId = [];
                });
            }
        }
        return next();
    });

    /**
     * PaymentInstruments-SetDefault : Marks a saved card as the shopper's default.
     * Mirrors the OOB Address-SetDefault flow. Sets custom.isDefault on the selected
     * card and clears it on all others (exactly one default), then returns to the list.
     * @name Cybersource/PaymentInstruments-SetDefault
     * @function
     * @memberof PaymentInstruments
     * @param {middleware} - userLoggedIn.validateLoggedIn
     * @param {querystringparameter} - UUID - UUID of the card to make default
     * @param {serverfunction} - get
     */
    server.get('SetDefault', userLoggedIn.validateLoggedIn, function (req, res, next) {
        var CustomerMgr = require('dw/customer/CustomerMgr');
        var defaultPaymentHelper = require('~/cartridge/scripts/helpers/defaultPaymentHelper');
        var uuid = req.querystring.UUID;
        var customer = CustomerMgr.getCustomerByCustomerNumber(
            req.currentCustomer.profile.customerNo
        );
        var wallet = customer.getProfile().getWallet();
        this.on('route:BeforeComplete', function () {
            if (uuid) {
                defaultPaymentHelper.setDefaultByUUID(wallet, uuid);
            }
            res.redirect(URLUtils.url('PaymentInstruments-List'));
        });
        return next();
    });

    /**
     * Appends to PaymentInstruments-DeletePayment so that deleting the default card
     * promotes another saved card to default (keeps exactly one default when cards remain).
     */
    server.append('DeletePayment', userLoggedIn.validateLoggedInAjax, function (req, res, next) {
        var CustomerMgr = require('dw/customer/CustomerMgr');
        var defaultPaymentHelper = require('~/cartridge/scripts/helpers/defaultPaymentHelper');
        this.on('route:BeforeComplete', function (req1) {
            var customer = CustomerMgr.getCustomerByCustomerNumber(
                req1.currentCustomer.profile.customerNo
            );
            var wallet = customer.getProfile().getWallet();
            defaultPaymentHelper.ensureSingleDefault(wallet);
        });
        return next();
    });

    /**
     * PaymentInstruments-SavePaymentDirect
     * 
     * Handles card save for UC v1.x completeMandate flow (My Account - Add Payment)
     * This endpoint is called when UC widget returns the completeMandate JWT after SAVE_CARD
     * 
     * Flow:
     * 1. Validates the completeMandate JWT
     * 2. Extracts token information (customer, paymentInstrument, instrumentIdentifier)
     * 3. Saves the TMS token to customer wallet
     * 4. Returns success with redirect URL to payment list
     */
    server.post('SavePaymentDirect', server.middleware.https, csrfProtection.validateAjaxRequest, userLoggedIn.validateLoggedInAjax, function (req, res, next) {
        var CustomerMgr = require('dw/customer/CustomerMgr');
        var Transaction = require('dw/system/Transaction');
        var Resource = require('dw/web/Resource');
        var Logger = require('dw/system/Logger');
        var payments = require('~/cartridge/scripts/http/payments');
        var ucPaymentHelper = require('~/cartridge/scripts/helpers/ucPaymentHelper');
        var accountHelpers = require('*/cartridge/scripts/helpers/accountHelpers');
        var addressHelpers = require('*/cartridge/scripts/helpers/addressHelpers');

        var logger = Logger.getLogger('Cybersource', 'SavePaymentDirect');

        // Get the completeMandate JWT from request
        var completeMandateJwt = request.httpParameterMap.completeMandateJwt.stringValue;
        var transientToken = request.httpParameterMap.transientToken.stringValue;

        if (!completeMandateJwt) {
            logger.error('SavePaymentDirect: Missing completeMandateJwt parameter');
            secureResponseHelper.secureJsonResponse(res, {
                error: true,
                errorMessage: Resource.msg('error.technical', 'checkout', null)
            });
            return next();
        }

        // Decode and validate the JWT
        var jwtPayload = payments.decodeCompleteMandateJwt(completeMandateJwt);

        if (!jwtPayload) {
            logger.error('SavePaymentDirect: JWT validation failed');
            secureResponseHelper.secureJsonResponse(res, {
                error: true,
                errorMessage: Resource.msg('error.technical', 'checkout', null)
            });
            return next();
        }

        // Check status - for SAVE_CARD, status should indicate success
        var status = jwtPayload.status;
        if (status !== 'AUTHORIZED' && status !== 'PENDING' && status !== 'COMPLETED') {
            logger.error('SavePaymentDirect: Save card not successful. Status: {0}', status);
            secureResponseHelper.secureJsonResponse(res, {
                error: true,
                errorMessage: Resource.msg('error.card.save.failed', 'payment', 'Unable to save card. Please try again.')
            });
            return next();
        }

        // Get current customer
        var customerNo = req.currentCustomer.profile.customerNo;
        var customerObj = CustomerMgr.getCustomerByCustomerNumber(customerNo);

        if (!customerObj || !customerObj.profile) {
            logger.error('SavePaymentDirect: Customer not found');
            secureResponseHelper.secureJsonResponse(res, {
                error: true,
                errorMessage: Resource.msg('error.technical', 'checkout', null)
            });
            return next();
        }

        // Token rate limiter check
        var tokenRateLimiterHelper = require('~/cartridge/scripts/helpers/tokenRateLimiterHelper');
        var isAllowed = tokenRateLimiterHelper.IsCustumerAllowedSinglePaymentInstrumentInsertion(customerObj);
        if (!isAllowed.result) {
            logger.warn('SavePaymentDirect: Rate limiter rejected');
            secureResponseHelper.secureJsonResponse(res, {
                error: true,
                errorMessage: Resource.msg('error.rate.limit.exceeded', 'payment', 'Too many card save attempts. Please try again later.')
            });
            return next();
        }

        // Extract card details from JWT and transient token
        var cardDetails = ucPaymentHelper.extractCardDetails(jwtPayload, transientToken, null);

        // Resolve the shopper's billing details from the transient token once. It is the
        // authoritative source for both the cardholder name and the billing address the
        // shopper entered/confirmed in the UC widget. (The completeMandate JWT carries only
        // orderInformation.amountDetails, no billTo.)
        var transientBillTo = null;
        if (transientToken) {
            try {
                var paymentDetails = payments.getPaymentDetails(transientToken);
                if (paymentDetails && paymentDetails.orderInformation && paymentDetails.orderInformation.billTo) {
                    transientBillTo = paymentDetails.orderInformation.billTo;
                }
            } catch (pdErr) {
                logger.warn('SavePaymentDirect: transient-token billing lookup failed: {0}', pdErr.message || pdErr);
            }
        }

        // Cardholder name: prefer the completeMandate JWT billTo (cheap, usually absent),
        // else fall back to the transient-token billTo (the source checkout uses).
        if (jwtPayload.details && jwtPayload.details.orderInformation && jwtPayload.details.orderInformation.billTo) {
            cardDetails.cardHolderName = ucPaymentHelper.buildCardHolderName(jwtPayload.details.orderInformation.billTo);
        }
        if (!cardDetails.cardHolderName && transientBillTo) {
            cardDetails.cardHolderName = ucPaymentHelper.buildCardHolderName(transientBillTo);
        }

        // Save token to wallet
        var saveResult = ucPaymentHelper.saveTokenToWallet(jwtPayload, cardDetails, customerObj);
        logger.info('SavePaymentDirect: saveTokenToWallet result={0}', saveResult);

        if (!saveResult) {
            // If saveTokenToWallet returns false, token may not be in JWT
            // Try creating payment instrument with card details only
            try {
                var wallet = customerObj.profile.wallet;
                var tokenInfo = ucPaymentHelper.extractTokenInformation(jwtPayload);

                if (tokenInfo && tokenInfo.paymentInstrument && tokenInfo.instrumentIdentifier) {
                    var serializedToken;
                    if (tokenInfo.customer && tokenInfo.customer.id) {
                        serializedToken = [
                            tokenInfo.instrumentIdentifier.id,
                            tokenInfo.paymentInstrument.id,
                            'flex',
                            tokenInfo.customer.id
                        ].join('-');

                        Transaction.wrap(function () {
                            if (!customerObj.profile.custom.customerID) {
                                customerObj.profile.custom.customerID = tokenInfo.customer.id;
                            }
                        });
                    } else {
                        serializedToken = [
                            tokenInfo.instrumentIdentifier.id,
                            tokenInfo.paymentInstrument.id,
                            'flex'
                        ].join('-');
                    }

                    // Dedupe: if a card with the same instrumentIdentifier already exists,
                    // update it instead of creating a duplicate (mirrors saveTokenToWallet).
                    // Upsert de-dupes by instrumentIdentifier and REPLACES an existing card
                    // (SFCC masks persisted instruments permanently, so we cannot mutate them).
                    var upsertResult = ucPaymentHelper.upsertCreditCard(
                        wallet,
                        serializedToken,
                        cardDetails,
                        tokenInfo.instrumentIdentifier.id
                    );

                    logger.info('SavePaymentDirect: Card {0} via fallback upsert. InstrumentIdentifier: {1}',
                        upsertResult.replacedExisting ? 'updated (replaced)' : 'saved',
                        tokenInfo.instrumentIdentifier.id);
                } else {
                    logger.error('SavePaymentDirect: No token information in JWT response');
                    secureResponseHelper.secureJsonResponse(res, {
                        error: true,
                        errorMessage: Resource.msg('error.card.save.failed', 'payment', 'Unable to save card. Please try again.')
                    });
                    return next();
                }
            } catch (e) {
                logger.error('SavePaymentDirect: Error saving card - {0}', e.message || e);
                secureResponseHelper.secureJsonResponse(res, {
                    error: true,
                    errorMessage: Resource.msg('error.technical', 'checkout', null)
                });
                return next();
            }
        }

        // Update rate limiter
        if (isAllowed.resetTimer) {
            tokenRateLimiterHelper.resetTimer(customerObj);
        }
        if (isAllowed.increaseCounter) {
            tokenRateLimiterHelper.increaseCounter(customerObj);
        }

        // Maintain the default saved card: first card or ticked checkbox becomes default.
        var defaultPaymentHelper = require('~/cartridge/scripts/helpers/defaultPaymentHelper');
        var defaultWallet = customerObj.getProfile().getWallet();
        var savedCards = defaultPaymentHelper.getCreditCardInstruments(defaultWallet);
        if (savedCards.length > 0) {
            // The UC AJAX posts makeDefaultPayment as a boolean; read it as such.
            var makeDefaultChecked = request.httpParameterMap.makeDefaultPayment.booleanValue;
            // Identify the card we just saved/updated by its instrumentIdentifier (robust
            // against wallet ordering and against an upsert that replaced an existing card).
            var savedTokenInfo = ucPaymentHelper.extractTokenInformation(jwtPayload);
            var savedPI = (savedTokenInfo && savedTokenInfo.instrumentIdentifier)
                ? ucPaymentHelper.findCreditCardByInstrumentIdentifier(defaultWallet, savedTokenInfo.instrumentIdentifier.id)
                : null;
            if (savedPI && (makeDefaultChecked || savedCards.length === 1)) {
                defaultPaymentHelper.setDefaultByUUID(defaultWallet, savedPI.UUID);
            } else {
                defaultPaymentHelper.ensureSingleDefault(defaultWallet);
            }
        }

        // Best-effort: add the billing address the shopper entered in the UC widget to
        // their address book (deduped). Never blocks the card save — the card is already
        // persisted at this point, so any failure here is logged and swallowed.
        try {
            var sfccAddress = ucPaymentHelper.mapUcBillToToSfccAddress(transientBillTo);
            var addressBook = req.currentCustomer.addressBook;
            // Require the minimal fields the dedup key uses (address1 + postalCode + city)
            // so we never store an incomplete entry.
            if (sfccAddress && sfccAddress.address1 && sfccAddress.postalCode && sfccAddress.city && addressBook) {
                if (!addressHelpers.checkIfAddressStored(sfccAddress, addressBook.addresses)) {
                    addressHelpers.saveAddress(sfccAddress, req.currentCustomer, addressHelpers.generateAddressName(sfccAddress));
                    logger.info('SavePaymentDirect: billing address added to address book for customer {0}', customerNo);
                }
            }
        } catch (addrErr) {
            logger.warn('SavePaymentDirect: address-book save skipped: {0}', addrErr.message || addrErr);
        }

        // Send account edited email
        accountHelpers.sendAccountEditedEmail(customerObj.profile);

        logger.info('SavePaymentDirect: Card saved successfully for customer {0}', customerNo);

        secureResponseHelper.secureJsonResponse(res, {
            success: true,
            redirectUrl: URLUtils.url('PaymentInstruments-List').toString()
        });

        return next();
    });
}

module.exports = server.exports();
