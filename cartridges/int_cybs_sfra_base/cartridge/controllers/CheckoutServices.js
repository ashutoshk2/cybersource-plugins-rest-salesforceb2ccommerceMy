'use strict';

var page = module.superModule;
var server = require('server');
var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');
server.extend(page);

// for Gpay on checkout page
server.post('SubmitPaymentGP', function (req, res, next) {
    var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
    var Encoding = require('dw/crypto/Encoding');
    var paymentForm = server.forms.getForm('billing');
    var BasketMgr = require('dw/order/BasketMgr');
    var billingFormErrors = {};
    var viewData = {};
    // eslint-disable-next-line no-shadow
    var BasketMgr = require('dw/order/BasketMgr');
    var cart = BasketMgr.getCurrentBasket();
    var Locale = require('dw/util/Locale');
    var OrderModel = require('*/cartridge/models/order');
    var Transaction = require('dw/system/Transaction');
    var currentLocale = Locale.getLocale(req.locale.id);
    var usingMultiShipping = false;
    var basketModel = new OrderModel(cart, {
        usingMultiShipping: usingMultiShipping,
        countryCode: currentLocale.country,
        containerView: 'basket'
    });
    // Check if request is from Unified Checkout
    // eslint-disable-next-line no-undef
    var isUnifiedCheckout = request.httpParameterMap.UC && request.httpParameterMap.UC.value === 'true';

    // eslint-disable-next-line no-undef
    var isminicart = request.httpParameterMap.isminicart && request.httpParameterMap.isminicart.value === 'true';
    // eslint-disable-next-line no-undef
    session.privacy.ipAddress = request.httpHeaders['x-is-remote_addr'];
    if (!isUnifiedCheckout) {
        // eslint-disable-next-line no-undef
        var paymentData = JSON.parse(request.httpParameterMap.googletoken);
    } else if (isUnifiedCheckout && isminicart) {
        var ucPaymentHelper = require('~/cartridge/scripts/helpers/ucPaymentHelper');
        var paymentDetails = ucPaymentHelper.processUCToken(paymentForm.creditCardFields.ucpaymenttoken.htmlValue);
        ucPaymentHelper.populateBasketAddresses(cart, paymentDetails, paymentForm);
    }

    billingFormErrors = COHelpers.validateBillingForm(paymentForm.addressFields);
    var contactFieldsErrors = COHelpers.validateBillingForm(paymentForm.contactInfoFields);
    if (Object.keys(billingFormErrors).length) {
        // respond with form data and errors
        secureResponseHelper.secureJsonResponse(res, {
            form: paymentForm,
            fieldErrors: [billingFormErrors],
            serverErrors: [],
            error: true
        });
    } else if (Object.keys(contactFieldsErrors).length) {
        secureResponseHelper.secureJsonResponse(res, {
            form: paymentForm,
            fieldErrors: [contactFieldsErrors],
            serverErrors: [],
            error: true
        });
    } else {
        viewData.address = {
            firstName: {
                value: paymentForm.addressFields.firstName.value
            },
            lastName: {
                value: paymentForm.addressFields.lastName.value
            },
            address1: {
                value: paymentForm.addressFields.address1.value
            },
            address2: {
                value: paymentForm.addressFields.address2.value
            },
            city: {
                value: paymentForm.addressFields.city.value
            },
            postalCode: {
                value: paymentForm.addressFields.postalCode.value
            },
            countryCode: {
                value: paymentForm.addressFields.country.value
            }
        };

        if (Object.prototype.hasOwnProperty
            .call(paymentForm.addressFields, 'states')) {
            viewData.address.stateCode = {
                value: paymentForm.addressFields.states.stateCode.value
            };
        }

        viewData.paymentMethod = {
            value: paymentForm.paymentMethod.value,
            htmlName: paymentForm.paymentMethod.value
        };

        viewData.email = {
            value: cart.customerEmail
        };

        viewData.phone = {
            value: paymentForm.contactInfoFields.phone.value
        };

        viewData.saveCard = paymentForm.creditCardFields.saveCard.checked;
        // Code to update card type details on place order page
        var paymentInstrument = null;
        // eslint-disable-next-line no-undef
        if (!empty(cart.getPaymentInstruments())) {
            paymentInstrument = cart.getPaymentInstruments()[0];
        }
        var cardType;
        if (paymentInstrument != null) {
            cardType = paymentInstrument.creditCardType;
        }
        if (paymentInstrument != null && paymentInstrument.paymentMethod === 'DW_GOOGLE_PAY') {
            basketModel.billing.payment.selectedPaymentInstruments[0].type = cardType;
            basketModel.billing.payment.selectedPaymentInstruments[0].maskedCreditCardNumber = paymentInstrument.creditCardNumber;
        }
        viewData.order = basketModel;
        res.setViewData(viewData);
        this.on('route:BeforeComplete', function (req, res) { // eslint-disable-line no-shadow
            // eslint-disable-next-line no-shadow
            var BasketMgr = require('dw/order/BasketMgr');
            var Resource = require('dw/web/Resource');
            var Transaction = require('dw/system/Transaction');
            // eslint-disable-next-line no-shadow
            var URLUtils = require('dw/web/URLUtils');
            var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
            // eslint-disable-next-line no-shadow
            var currentBasket = BasketMgr.getCurrentBasket();
            var billingData = res.getViewData();
            if (!currentBasket) {
                delete billingData.paymentInformation;
                secureResponseHelper.secureJsonResponse(res, {
                    error: true,
                    cartError: true,
                    fieldErrors: [],
                    serverErrors: [],
                    redirectUrl: URLUtils.url('Cart-Show').toString()
                });
                return;
            }
            var billingAddress = currentBasket.billingAddress;
            var billingForm = server.forms.getForm('billing');
            billingForm.creditCardFields.cardNumber.htmlValue = '';
            billingForm.creditCardFields.securityCode.htmlValue = '';
            Transaction.wrap(function () {
                if (!billingAddress) {
                    billingAddress = currentBasket.createBillingAddress();
                }
                billingAddress.setFirstName(billingData.address.firstName.value);
                billingAddress.setLastName(billingData.address.lastName.value);
                billingAddress.setAddress1(billingData.address.address1.value);
                billingAddress.setAddress2(billingData.address.address2.value);
                billingAddress.setCity(billingData.address.city.value);
                billingAddress.setPostalCode(billingData.address.postalCode.value);
                if (Object.prototype.hasOwnProperty.call(billingData.address, 'stateCode')) {
                    billingAddress.setStateCode(billingData.address.stateCode.value);
                }
                billingAddress.setCountryCode(billingData.address.countryCode.value);

                if (billingData.storedPaymentUUID) {
                    billingAddress.setPhone(req.currentCustomer.profile.phone);
                    currentBasket.setCustomerEmail(req.currentCustomer.profile.email);
                } else {
                    billingAddress.setPhone(billingData.phone.value);
                    currentBasket.setCustomerEmail(billingData.email.value);
                }
            });
            // Add hook to call google payment
            var mobileAdaptor = require('*/cartridge/scripts/mobilepayments/MobilePaymentsAdapter');

            if (isUnifiedCheckout) {
                var result = mobileAdaptor.updateBilling(currentBasket, null, billingData.email.value);
                Transaction.wrap(function () {
                    var paymentInstruments = currentBasket.getPaymentInstruments();
                    if (paymentInstruments.length > 0) {
                        paymentInstruments[0].custom.UCToken = paymentForm.creditCardFields.ucpaymenttoken.value;
                    }
                });
            } else {
                var result = mobileAdaptor.updateBilling(currentBasket, paymentData.paymentMethodData.info, billingData.email.value);
                var GPtoken = paymentData.paymentMethodData.tokenizationData.token;
                Transaction.wrap(function () {
                    var paymentInstruments = currentBasket.getPaymentInstruments();
                    if (paymentInstruments.length > 0) {
                        paymentInstruments[0].custom.GooglePayEncryptedData = Encoding.toBase64(new dw.util.Bytes(GPtoken));
                        paymentInstruments[0].custom.isGooglePaycardHolderAuthenticated = paymentData.paymentMethodData.info.assuranceDetails.cardHolderAuthenticated;;
                    }
                });
            }

            // Calculate the basket
            Transaction.wrap(function () {
                basketCalculationHelpers.calculateTotals(currentBasket);
            });
            // Re-calculate the payments.
            var calculatedPaymentTransaction = COHelpers.calculatePaymentTransaction(currentBasket);
            if (calculatedPaymentTransaction.error) {
                secureResponseHelper.secureJsonResponse(res, {
                    form: paymentForm,
                    fieldErrors: [],
                    serverErrors: [Resource.msg('error.technical', 'checkout', null)],
                    error: true
                });
                return;
            }
            // return back google
            if (result.success) {
                // eslint-disable-next-line no-undef
                if (request.httpParameterMap.paymentData != null && !isminicart) {
                    secureResponseHelper.secureJsonResponse(res, {
                        error: false
                    });
                } else if (isminicart) {
                    var AccountModel = require('*/cartridge/models/account');
                    var accountModel = new AccountModel(req.currentCustomer);
                    var renderedStoredPaymentInstrument = COHelpers.getRenderedPaymentInstruments(
                        req,
                        accountModel
                    );

                    secureResponseHelper.secureJsonResponse(res, {
                        error: false,
                        order: basketModel,
                        customer: accountModel,
                        renderedPaymentInstruments: renderedStoredPaymentInstrument,
                        form: billingForm,
                        continueUrl: URLUtils.url('Checkout-Begin', 'stage', 'placeOrder').toString()
                    });
                }
            }
        });
    }
    return next();
});

/**
 * *
 * @param {*} cart *
 * @param {*} shippingdetails *
 * @returns {*} *
 */
function shippingUpdate(cart, shippingdetails) {
    var logger = require('dw/system/Logger');
    var mobileAdaptor;
    var shipment = cart.defaultShipment;
    // eslint-disable-next-line no-undef
    if (!empty(shipment.getShippingAddress())) {
        mobileAdaptor = require('*/cartridge/scripts/mobilepayments/MobilePaymentsAdapter');
        mobileAdaptor.updateShipping(shippingdetails);
        return {
            success: true
        };
    }
    try {
        mobileAdaptor = require('*/cartridge/scripts/mobilepayments/MobilePaymentsAdapter');
        mobileAdaptor.updateShipping(shippingdetails);
        return {
            success: true
        };
    } catch (err) {
        logger.error('Error creating shipment from Google pay address: {0}', err.message);
        return {
            error: true,
            errorMsg: err.message
        };
    }
}

//for Gapy on cart and minicart
// eslint-disable-next-line consistent-return
server.post('GetGooglePayToken', function (req, res, next) {
    var Encoding = require('dw/crypto/Encoding');
    var paymentForm = server.forms.getForm('billing');
    var payments = require('*/cartridge/scripts/http/payments');
    // Check if this is from Unified Checkout
    var isUnifiedCheckout = request.httpParameterMap.UC && request.httpParameterMap.UC.value === 'true';
    var response = '';
    var CardHelper = require('../scripts/helpers/CardHelper');
    var Resource = require('dw/web/Resource');
    // eslint-disable-next-line no-shadow
    var BasketMgr = require('dw/order/BasketMgr');
    var cart = BasketMgr.getCurrentBasket();
    var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
    // eslint-disable-next-line no-shadow
    var URLUtils = require('dw/web/URLUtils');
    var mobileAdaptor = require('*/cartridge/scripts/mobilepayments/MobilePaymentsAdapter');
    var Transaction = require('dw/system/Transaction');
    var logger = require('dw/system/Logger');
    // eslint-disable-next-line no-undef
    session.privacy.ipAddress = request.httpHeaders['x-is-remote_addr'];

    if (isUnifiedCheckout) {
        var transientToken = paymentForm.creditCardFields.ucpaymenttoken.value;
        var paymentDetails = payments.getPaymentDetails(transientToken);
        var orderInformation = paymentDetails.orderInformation;
        var shippingdetails = paymentDetails.orderInformation.shipTo;
        var result = mobileAdaptor.updateBilling(cart, orderInformation.billTo, orderInformation.billTo.email);
        if (result.success) {
            result = shippingUpdate(cart, shippingdetails);
            if (result.success) {
                cart = BasketMgr.getCurrentBasket();
                // calculate cart and redirect to summary page
                COHelpers.recalculateBasket(cart);
                var ShippingHelper = require('*/cartridge/scripts/checkout/shippingHelpers');
                Transaction.wrap(function () {
                    ShippingHelper.selectShippingMethod(cart.defaultShipment, null);
                });
                // Store UC token info if available from Unified Checkout
                if (isUnifiedCheckout && paymentDetails) {
                    Transaction.wrap(function () {
                        // Get the payment instrument
                        var paymentInstruments = cart.getPaymentInstruments('DW_GOOGLE_PAY');
                        if (paymentInstruments && paymentInstruments.length > 0) {
                            var paymentInstrument = paymentInstruments[0];
                            // Store the transient token as a custom attribute
                            paymentInstrument.custom.UCToken = transientToken;
                        }
                    });
                }
            }
        } else {

            logger.error('Error in google Checkout payment: problem in billing details');
            Transaction.wrap(function () {
                CardHelper.removeExistingPaymentInstruments(cart);
            });
            COHelpers.recalculateBasket(cart);
            secureResponseHelper.secureJsonResponse(res, {
                redirectUrl: URLUtils.url('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('message.payerAuthError', 'error', null)),
                error: true
            });
            return next();
        }

    } else {
        response = JSON.parse(request.httpParameterMap.paymentData);
        var shippingdetails = response.shippingAddress; // add condition for only cart
        var result = mobileAdaptor.updateBilling(cart, response.paymentMethodData.info, response.email);
        if (result.success) {
            result = shippingUpdate(cart, shippingdetails);
            if (result.success) {
                cart = BasketMgr.getCurrentBasket();
                // calculate cart and redirect to summary page
                COHelpers.recalculateBasket(cart);
                var ShippingHelper = require('*/cartridge/scripts/checkout/shippingHelpers');
                Transaction.wrap(function () {
                    ShippingHelper.selectShippingMethod(cart.defaultShipment, null);
                });
                var GPtoken = response.paymentMethodData.tokenizationData.token;
                Transaction.wrap(function () {
                    var paymentInstruments = cart.getPaymentInstruments();
                    if (paymentInstruments.length > 0) {
                        paymentInstruments[0].custom.GooglePayEncryptedData = Encoding.toBase64(new dw.util.Bytes(GPtoken));
                        paymentInstruments[0].custom.isGooglePaycardHolderAuthenticated = response.paymentMethodData.info.assuranceDetails.cardHolderAuthenticated;
                    }
                });
            }
        } else {
            logger.error('Error in google Checkout payment: problem in billing details');
            Transaction.wrap(function () {
                CardHelper.removeExistingPaymentInstruments(cart);
            });
            COHelpers.recalculateBasket(cart);
            secureResponseHelper.secureJsonResponse(res, {
                redirectUrl: URLUtils.url('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('message.payerAuthError', 'error', null)),
                error: true
            });
            return next();
        }
    }
    // eslint-disable-next-line no-undef
    if (request.httpParameterMap.paymentData != null) {
        secureResponseHelper.secureJsonResponse(res, {
            status: 'success'
        });
        return next();

    } else {
        logger.error('Error in google Checkout payment: problem in billing details');
        Transaction.wrap(function () {
            CardHelper.removeExistingPaymentInstruments(cart);
        });
        COHelpers.recalculateBasket(cart);
        secureResponseHelper.secureJsonResponse(res, {
            redirectUrl: URLUtils.url('Checkout-Begin', 'stage', 'payment', 'payerAuthError', 'error').toString(),
            error: true
        });
        return next();
    }
});

// Returns the current basket total as a plain numeric string for Google Pay
server.get('GetCartTotal', function (req, res, next) {
    var BasketMgr = require('dw/order/BasketMgr');
    var cart = BasketMgr.getCurrentBasket();

    if (!cart) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            totalPrice: '0'
        });
        return next();
    }

    var totalGrossPrice = cart.totalGrossPrice;
    var currencyCode = totalGrossPrice.currencyCode;

    var totalPrice = totalGrossPrice.value.toFixed(2);

    secureResponseHelper.secureJsonResponse(res, {
        error: false,
        totalPrice: totalPrice,
        currencyCode: currencyCode
    });

    return next();
});

/**
 * CheckoutServices-PlaceOrderDirect
 * 
 * Handles order placement for UC v1.x completeMandate flow where authorization
 * has already been performed by the SDK. This endpoint:
 * 1. Validates the completeMandate JWT response
 * 2. Creates the order from basket
 * 3. Maps transaction details to payment instrument (skips authorization since SDK already did it)
 * 4. Runs fraud detection based on SDK response status
 * 5. Places the order and redirects to confirmation
 * 
 * @param {Object} req - Request object containing completeMandateJwt parameter
 * @returns {Object} JSON response with orderID, orderToken, continueUrl or error
 */
server.post('PlaceOrderDirect', server.middleware.https, function (req, res, next) {
    var BasketMgr = require('dw/order/BasketMgr');
    var OrderMgr = require('dw/order/OrderMgr');
    var PaymentMgr = require('dw/order/PaymentMgr');
    var Resource = require('dw/web/Resource');
    var Transaction = require('dw/system/Transaction');
    var URLUtils = require('dw/web/URLUtils');
    var Logger = require('dw/system/Logger');
    var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
    var hooksHelper = require('*/cartridge/scripts/helpers/hooks');
    var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
    var validationHelpers = require('*/cartridge/scripts/helpers/basketValidationHelpers');
    var addressHelpers = require('*/cartridge/scripts/helpers/addressHelpers');
    var payments = require('*/cartridge/scripts/http/payments');
    var ucPaymentHelper = require('~/cartridge/scripts/helpers/ucPaymentHelper');

    var logger = Logger.getLogger('Cybersource', 'PlaceOrderDirect');

    // Get the completeMandate JWT from request
    var completeMandateJwt = request.httpParameterMap.completeMandateJwt.stringValue;
    var transientToken = request.httpParameterMap.transientToken.stringValue;

    if (!completeMandateJwt) {
        logger.error('PlaceOrderDirect: Missing completeMandateJwt parameter');
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Decode and validate the JWT
    var jwtPayload = payments.decodeCompleteMandateJwt(completeMandateJwt);

    if (!jwtPayload) {
        logger.error('PlaceOrderDirect: JWT validation failed');
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Check authorization status
    var authStatus = jwtPayload.status;
    if (!ucPaymentHelper.isValidAuthorizationStatus(authStatus)) {
        logger.error('PlaceOrderDirect: Authorization not successful. Status: {0}', authStatus);
        
        // Check if SCA (Strong Customer Authentication) is required
        // Expanded SCA detection for new CyberSource response patterns
        var isSCARequired = false;
        var processorInfo = jwtPayload.details && jwtPayload.details.processorInformation;
        var reasonCode = processorInfo && processorInfo.responseCode;
        var reason = jwtPayload.reason;
        var message = jwtPayload.message;
        var outcome = jwtPayload.outcome;
        // SCA required indicators: response 478, authentication_required status, or new CyberSource patterns
        if (
            reasonCode === '478' ||
            authStatus === 'AUTHENTICATION_REQUIRED' ||
            authStatus === 'PENDING_AUTHENTICATION' ||
            (reason && reason === 'CUSTOMER_AUTHENTICATION_REQUIRED') ||
            (message && typeof message === 'string' && message.toLowerCase().indexOf('strong customer authentication required') !== -1)
        ) {
            isSCARequired = true;
            ucPaymentHelper.setSCARequiredFlag();
            logger.info('PlaceOrderDirect: SCA required detected (reasonCode: {0}, status: {1}, reason: {2}, outcome: {3}). Flag set for retry.', reasonCode, authStatus, reason, outcome);
        }
        
        // Return appropriate error message
        var errorMessage;
        if (isSCARequired) {
            errorMessage = ucPaymentHelper.getSCAErrorMessage();
        } else {
            errorMessage = ucPaymentHelper.getAuthorizationErrorMessage(authStatus) || Resource.msg('error.technical', 'checkout', null);
        }
        
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: errorMessage,
            scaRequired: isSCARequired
        });
        return next();
    }

    // Get current basket
    var currentBasket = BasketMgr.getCurrentBasket();
    if (!currentBasket) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            fieldErrors: [],
            serverErrors: [],
            redirectUrl: URLUtils.url('Cart-Show').toString()
        });
        return next();
    }

    // Validate products in basket
    var validatedProducts = validationHelpers.validateProducts(currentBasket);
    if (validatedProducts.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            fieldErrors: [],
            serverErrors: [],
            redirectUrl: URLUtils.url('Cart-Show').toString()
        });
        return next();
    }

    // Check fraud detection status from session
    if (req.session.privacyCache.get('fraudDetectionStatus')) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', '01').toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }



    // For minicart/cart flows: Populate addresses from transient token via getPaymentDetails API
    // UC widget captures billing/shipping via captureMandate when requestShipping=true, billingType='FULL'
    // The addresses are NOT in the completeMandate JWT - they come from the transient token API
    if (transientToken && (!currentBasket.billingAddress || !currentBasket.defaultShipment.shippingAddress)) {
        try {
            var paymentDetails = payments.getPaymentDetails(transientToken);
            if (paymentDetails && paymentDetails.orderInformation) {
                // Populate addresses from API response
                ucPaymentHelper.populateBasketAddressesFromPaymentDetails(currentBasket, paymentDetails, Transaction);
                logger.info('PlaceOrderDirect: Addresses populated from getPaymentDetails API (minicart/cart flow)');
                
                // Set default shipping method if not present
                ucPaymentHelper.setDefaultShippingMethod(currentBasket, Transaction);
                
                // Recalculate basket totals with new addresses (for tax calculation)
                Transaction.wrap(function () {
                    basketCalculationHelpers.calculateTotals(currentBasket);
                });
            }
        } catch (e) {
            logger.error('PlaceOrderDirect: Error getting payment details from transient token: {0}', e.message || e);
        }
    }
        // Validate order
    var validationOrderStatus = hooksHelper('app.validate.order', 'validateOrder', currentBasket, require('*/cartridge/scripts/hooks/validateOrder').validateOrder);
    if (validationOrderStatus.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: validationOrderStatus.message
        });
        return next();
    }

    // Check shipping address exists
    if (currentBasket.defaultShipment.shippingAddress === null) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorStage: { stage: 'shipping', step: 'address' },
            errorMessage: Resource.msg('error.no.shipping.address', 'checkout', null)
        });
        return next();
    }

    // Check billing address exists
    if (!currentBasket.billingAddress) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorStage: { stage: 'payment', step: 'billingAddress' },
            errorMessage: Resource.msg('error.no.billing.address', 'checkout', null)
        });
        return next();
    }

    // Detect payment type from completeMandate JWT
    var detectedPaymentMethod = ucPaymentHelper.detectPaymentMethod(jwtPayload);
    var isDigitalWallet = detectedPaymentMethod === 'DW_GOOGLE_PAY' || detectedPaymentMethod === 'DW_APPLE_PAY';

    // Create or update payment instrument with correct payment method
    Transaction.wrap(function () {
        var existingInstruments = currentBasket.getPaymentInstruments();
        var paymentInstrument;

        for (var i = 0; i < existingInstruments.length; i++) {
            var existing = existingInstruments[i];
            if (existing.paymentMethod === detectedPaymentMethod) {
                paymentInstrument = existing;
            } else {
                currentBasket.removePaymentInstrument(existing);
            }
        }

        if (!paymentInstrument) {
            paymentInstrument = currentBasket.createPaymentInstrument(
                detectedPaymentMethod,
                currentBasket.totalGrossPrice
            );
            logger.info('PlaceOrderDirect: Created payment instrument with method: {0}', detectedPaymentMethod);
        }

            if (currentBasket.billingAddress && currentBasket.billingAddress.fullName) {
                paymentInstrument.setCreditCardHolder(currentBasket.billingAddress.fullName);
            }

            if (transientToken) {
                paymentInstrument.custom.UCToken = transientToken;
            }

        // Extract and set card details before validation (required for SFRA validatePayment cardType check)
        var cardDetails = ucPaymentHelper.extractCardDetails(jwtPayload, transientToken, currentBasket.billingAddress);
        ucPaymentHelper.updatePaymentInstrumentCardDetails(paymentInstrument, cardDetails, isDigitalWallet);
    });

    // Calculate basket totals
    Transaction.wrap(function () {
        basketCalculationHelpers.calculateTotals(currentBasket);
    });

    // Validate payment instruments
    var validPayment = COHelpers.validatePayment(req, currentBasket);
    if (validPayment.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorStage: { stage: 'payment', step: 'paymentInstrument' },
            errorMessage: Resource.msg('error.payment.not.valid', 'checkout', null)
        });
        return next();
    }

    // Calculate payment transaction
    var calculatedPaymentTransactionTotal = COHelpers.calculatePaymentTransaction(currentBasket);
    if (calculatedPaymentTransactionTotal.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Create order from basket
    var order = COHelpers.createOrder(currentBasket);
    if (!order) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Extract transaction details from JWT payload
    var transactionId = jwtPayload.id;
    var processorInfo = jwtPayload.details && jwtPayload.details.processorInformation;
    var isDigitalWallet = detectedPaymentMethod === 'DW_GOOGLE_PAY' || detectedPaymentMethod === 'DW_APPLE_PAY';

    // Set order status in session for fraud detection hook
    session.privacy.orderStatus = authStatus;

    // Update payment instrument with transaction details from SDK authorization
    try {
        Transaction.wrap(function () {
            var paymentInstruments = order.getPaymentInstruments();
            if (paymentInstruments.length > 0) {
                var paymentInstrument = paymentInstruments[0];
                var paymentProcessor = PaymentMgr.getPaymentMethod(paymentInstrument.paymentMethod).paymentProcessor;

                // Set transaction ID and processor
                paymentInstrument.paymentTransaction.setTransactionID(transactionId);
                if (paymentProcessor) {
                    paymentInstrument.paymentTransaction.setPaymentProcessor(paymentProcessor);
                }

                // Extract and set card details (pass order billing address for cardholder name)
                var cardDetails = ucPaymentHelper.extractCardDetails(jwtPayload, transientToken, order.billingAddress);
                ucPaymentHelper.updatePaymentInstrumentCardDetails(paymentInstrument, cardDetails, isDigitalWallet);

                // Set payment details string
                var paymentDetailsStr = ucPaymentHelper.buildPaymentDetailsString(cardDetails);
                paymentInstrument.paymentTransaction.custom.paymentDetails = paymentDetailsStr;

                // Store transient token for potential refunds/captures
                if (transientToken) {
                    paymentInstrument.custom.UCToken = transientToken;
                }

                // Store optional processor info (if custom attributes exist)
                if (processorInfo) {
                    ucPaymentHelper.setTransactionCustomAttribute(
                        paymentInstrument.paymentTransaction, 'approvalCode', processorInfo.approvalCode
                    );
                    ucPaymentHelper.setTransactionCustomAttribute(
                        paymentInstrument.paymentTransaction, 'networkTransactionId', processorInfo.networkTransactionId
                    );
                }
                if (jwtPayload.details && jwtPayload.details.reconciliationId) {
                    ucPaymentHelper.setTransactionCustomAttribute(
                        paymentInstrument.paymentTransaction, 'reconciliationId', jwtPayload.details.reconciliationId
                    );
                }

                logger.info('PlaceOrderDirect: Payment instrument updated - TransactionID: {0}, PaymentDetails: {1}, PaymentMethod: {2}',
                    transactionId, paymentDetailsStr, paymentInstrument.paymentMethod);
            }
        });
    } catch (e) {
        logger.error('PlaceOrderDirect: Error updating payment instrument: {0}', e.message || e);
        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Run fraud detection hook
    var fraudDetectionStatus = hooksHelper('app.fraud.detection', 'fraudDetection', currentBasket, require('*/cartridge/scripts/hooks/fraudDetection').fraudDetection);
    if (fraudDetectionStatus.status === 'fail') {
        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
        req.session.privacyCache.set('fraudDetectionStatus', true);
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', fraudDetectionStatus.errorCode).toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Place the order
    var placeOrderResult = COHelpers.placeOrder(order, fraudDetectionStatus);
    if (placeOrderResult.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Check for staged webhook payloads that arrived before order creation
    try {
        var CustomObjectMgr = require('dw/object/CustomObjectMgr');
        var stagingObj = CustomObjectMgr.getCustomObject('CybersourceWebhookStaging', order.orderNo);
        if (stagingObj) {
            var stagedPayload = JSON.parse(stagingObj.custom.payload);
            var webhookDetails = (stagedPayload.payload && stagedPayload.payload.transactionResult) ? stagedPayload.payload.transactionResult.details : (stagedPayload.payload ? stagedPayload.payload[0].data : stagedPayload);
            
            Transaction.wrap(function () {
                if (webhookDetails.status === 'COMPLETED' || webhookDetails.status === 'SETTLED' || webhookDetails.status === 'AUTHORIZED') {
                    order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                } else if (webhookDetails.status === 'AUTHORIZED_PENDING_REVIEW') {
                    order.setConfirmationStatus(order.CONFIRMATION_STATUS_NOTCONFIRMED);
                }
                CustomObjectMgr.remove(stagingObj);
            });
            logger.info('PlaceOrderDirect: Applied staged webhook payload and removed staging object for order {0}', order.orderNo);
        }
    } catch (stagingErr) {
        logger.error('PlaceOrderDirect: Error applying staged webhook payload: {0}', stagingErr.message || stagingErr);
    }

    // Save TMS token to customer wallet if user opted to save card
    // Extract card details first (needed for wallet entry) - pass billing address for cardholder name
    var cardDetailsForWallet = ucPaymentHelper.extractCardDetails(jwtPayload, transientToken, order.billingAddress);
    var tokenSaved = ucPaymentHelper.saveTokenToWallet(jwtPayload, cardDetailsForWallet, session.getCustomer());
    if (tokenSaved) {
        logger.info('PlaceOrderDirect: TMS token saved to customer wallet');
    }

    // Network Token Subscription: Subscribe to network token lifecycle updates when enabled
    // This allows the integration to receive webhook notifications when network tokens are updated
    var configObject = require('~/cartridge/configuration/index');
    if (configObject.networkTokenizationEnabled && processorInfo && processorInfo.paymentAccountReferenceNumber) {
        try {
            var networkTokenSubscription = require('~/cartridge/scripts/http/networkTokenSubscription');
            networkTokenSubscription.createNetworkTokenSubscription();
            logger.info('PlaceOrderDirect: Network token subscription created/verified for PAR');
        } catch (ntError) {
            // Log but don't fail the order - network token subscription is non-critical
            logger.warn('PlaceOrderDirect: Failed to create network token subscription: {0}', ntError.message || ntError);
        }
    }

    // Save addresses to address book for logged in customers
    if (req.currentCustomer.addressBook) {
        var allAddresses = addressHelpers.gatherShippingAddresses(order);
        allAddresses.forEach(function (address) {
            if (!addressHelpers.checkIfAddressStored(address, req.currentCustomer.addressBook.addresses)) {
                addressHelpers.saveAddress(address, req.currentCustomer, addressHelpers.generateAddressName(address));
            }
        });
    }

    // Send confirmation email
    if (order.getCustomerEmail()) {
        COHelpers.sendConfirmationEmail(order, req.locale.id);
    }

    // Reset multi-shipping flag
    req.session.privacyCache.set('usingMultiShipping', false);

    logger.info('PlaceOrderDirect: Order placed successfully. OrderNo: {0}, TransactionID: {1}', order.orderNo, transactionId);

    // Return success
    secureResponseHelper.secureJsonResponse(res, {
        error: false,
        orderID: order.orderNo,
        orderToken: order.orderToken,
        continueUrl: URLUtils.url('Order-Confirm').toString()
    });

    return next();
});

module.exports = server.exports();
