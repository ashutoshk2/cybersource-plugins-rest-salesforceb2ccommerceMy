'use strict';

/**
 * Helper functions for Unified Checkout payment processing
 * Includes:
 * - Token processing and address population
 * - completeMandate helpers for PlaceOrderDirect flow
 * - Capture context building helpers
 * - TMS token saving helpers
 */

var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger');
var logger = Logger.getLogger('Cybersource', 'UCPaymentHelper');

// ============================================================================
// Token Processing Functions
// ============================================================================

/**
 * Process UC payment token and populate basket with billing/shipping addresses
 * @param {string} token - UC JWT token
 * @returns {Object} Payment details from UC API
 */
function processUCToken(token) {
    var payments = require('~/cartridge/scripts/http/payments.js');

    if (!token) {
        throw new Error('UC payment token is required');
    }

    var paymentDetails;
    try {
        paymentDetails = payments.getPaymentDetails(token);
    } catch (e) {
        var errorMsg = (e instanceof Error) ? e.message : String(e);
        throw new Error('Failed to retrieve payment details from Unified Checkout: ' + errorMsg);
    }

    return paymentDetails;
}

/**
 * Populate basket addresses from UC payment details
 * Only populates if addresses are empty (minicart flow)
 * Normal checkout flow already has addresses populated before form processor
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} paymentDetails - Payment details from UC API
 * @param {Object} paymentForm - Payment form object
 */
function populateBasketAddresses(basket, paymentDetails, paymentForm) {
    var shipment = basket.getDefaultShipment();
    var isEmailRequired = empty(basket.getCustomerEmail()) || empty(basket.customerEmail) || basket.getCustomerEmail() === 'undefined' || basket.customerEmail === 'undefined';

    Transaction.wrap(function () {
        var shippingAddress = shipment.createShippingAddress();

        var shipTo = paymentDetails.orderInformation.shipTo;
        shippingAddress.setFirstName(shipTo.firstName);
        shippingAddress.setLastName(shipTo.lastName);
        shippingAddress.setAddress1(shipTo.address1);
        if (!empty(shipTo.address2)) {
            shippingAddress.setAddress2(shipTo.address2);
        }
        shippingAddress.setCity(shipTo.locality);
        shippingAddress.setPostalCode(shipTo.postalCode);
        shippingAddress.setCountryCode(shipTo.country);
        shippingAddress.setStateCode(shipTo.administrativeArea);
        if (shipTo.phoneNumber) {
            shippingAddress.setPhone(shipTo.phoneNumber);
        }

        // Populate billing address
        var billingAddress = basket.createBillingAddress();
        var billTo = paymentDetails.orderInformation.billTo;
        billingAddress.setFirstName(billTo.firstName);
        billingAddress.setLastName(billTo.lastName);
        billingAddress.setAddress1(billTo.address1);
        if (!empty(billTo.address2)) {
            billingAddress.setAddress2(billTo.address2);
        }
        billingAddress.setCity(billTo.locality);
        billingAddress.setPostalCode(billTo.postalCode);
        billingAddress.setCountryCode(billTo.country);
        billingAddress.setStateCode(billTo.administrativeArea);
        billingAddress.setPhone(billTo.phoneNumber);
        if (isEmailRequired) {
            basket.setCustomerEmail(billTo.email);
        }
        // If shipping phone is empty, copy billing phone to shipping
        if (empty(shipTo.phoneNumber)) {
            if (billTo.phoneNumber) {
                shippingAddress.setPhone(billTo.phoneNumber);
            }
        }
        // Always update paymentForm billing fields if provided
        if (paymentForm && paymentForm.addressFields) {
            paymentForm.addressFields.firstName.value = billTo.firstName;
            paymentForm.addressFields.lastName.value = billTo.lastName;
            paymentForm.addressFields.address1.value = billTo.address1;
            if (!empty(billTo.address2)) {
                paymentForm.addressFields.address2.value = billTo.address2;
            }
            paymentForm.addressFields.city.value = billTo.locality;
            paymentForm.addressFields.postalCode.value = billTo.postalCode;
            paymentForm.addressFields.country.value = billTo.country;
            if (paymentForm.addressFields.states && billTo.administrativeArea) {
                paymentForm.addressFields.states.stateCode.value = billTo.administrativeArea;
            }
            if (paymentForm.contactInfoFields && billTo.phoneNumber) {
                paymentForm.contactInfoFields.phone.value = billTo.phoneNumber;
            }
        }
    });
}

/**
 * Update viewData object from populated payment form
 * @param {Object} paymentForm - Payment form object (already populated)
 * @param {Object} viewData - Existing viewData object to update
 * @returns {Object} Updated viewData object
 */
function updateViewDataFromForm(paymentForm, viewData) {
    var updatedViewData = viewData || {};

    if (paymentForm && paymentForm.addressFields) {
        updatedViewData.address = {
            firstName: { value: paymentForm.addressFields.firstName.value },
            lastName: { value: paymentForm.addressFields.lastName.value },
            address1: { value: paymentForm.addressFields.address1.value },
            address2: { value: paymentForm.addressFields.address2.value },
            city: { value: paymentForm.addressFields.city.value },
            postalCode: { value: paymentForm.addressFields.postalCode.value },
            countryCode: { value: paymentForm.addressFields.country.value }
        };

        if (Object.prototype.hasOwnProperty.call(paymentForm.addressFields, 'states')) {
            updatedViewData.address.stateCode = { value: paymentForm.addressFields.states.stateCode.value };
        }
    }

    if (paymentForm && paymentForm.contactInfoFields) {
        updatedViewData.phone = { value: paymentForm.contactInfoFields.phone.value };
    }

    return updatedViewData;
}

/**
 * Populate basket addresses from getPaymentDetails API response
 * Simplified version for PlaceOrderDirect flow (no paymentForm needed)
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} paymentDetails - Payment details from getPaymentDetails API
 * @param {Object} TransactionObj - DW Transaction object
 */
function populateBasketAddressesFromPaymentDetails(basket, paymentDetails, TransactionObj) {
    if (!paymentDetails || !paymentDetails.orderInformation) {
        logger.warn('populateBasketAddressesFromPaymentDetails: No orderInformation in paymentDetails');
        return;
    }

    var orderInfo = paymentDetails.orderInformation;
    var shipment = basket.getDefaultShipment();

    TransactionObj.wrap(function () {
        // Populate shipping address if shipTo exists in response
        if (orderInfo.shipTo && !shipment.shippingAddress) {
            var shippingAddress = shipment.createShippingAddress();
            var shipTo = orderInfo.shipTo;
            
            if (shipTo.firstName) shippingAddress.setFirstName(shipTo.firstName);
            if (shipTo.lastName) shippingAddress.setLastName(shipTo.lastName);
            if (shipTo.address1) shippingAddress.setAddress1(shipTo.address1);
            if (shipTo.address2) shippingAddress.setAddress2(shipTo.address2);
            if (shipTo.locality) shippingAddress.setCity(shipTo.locality);
            if (shipTo.postalCode) shippingAddress.setPostalCode(shipTo.postalCode);
            if (shipTo.country) shippingAddress.setCountryCode(shipTo.country);
            if (shipTo.administrativeArea) shippingAddress.setStateCode(shipTo.administrativeArea);
            if (shipTo.phoneNumber) shippingAddress.setPhone(shipTo.phoneNumber);
            
            logger.info('populateBasketAddressesFromPaymentDetails: Shipping address populated');
        }

        // Populate billing address if billTo exists in response
        if (orderInfo.billTo && !basket.billingAddress) {
            var billingAddress = basket.createBillingAddress();
            var billTo = orderInfo.billTo;
            
            if (billTo.firstName) billingAddress.setFirstName(billTo.firstName);
            if (billTo.lastName) billingAddress.setLastName(billTo.lastName);
            if (billTo.address1) billingAddress.setAddress1(billTo.address1);
            if (billTo.address2) billingAddress.setAddress2(billTo.address2);
            if (billTo.locality) billingAddress.setCity(billTo.locality);
            if (billTo.postalCode) billingAddress.setPostalCode(billTo.postalCode);
            if (billTo.country) billingAddress.setCountryCode(billTo.country);
            if (billTo.administrativeArea) billingAddress.setStateCode(billTo.administrativeArea);
            if (billTo.phoneNumber) billingAddress.setPhone(billTo.phoneNumber);
            
            if (billTo.email && !basket.customerEmail) {
                basket.setCustomerEmail(billTo.email);
            }
            
            logger.info('populateBasketAddressesFromPaymentDetails: Billing address populated');
        }

        // If shipping phone is empty but billing phone exists, copy it
        var shippingAddr = shipment.shippingAddress;
        if (shippingAddr && !shippingAddr.phone && orderInfo.billTo && orderInfo.billTo.phoneNumber) {
            shippingAddr.setPhone(orderInfo.billTo.phoneNumber);
        }
    });
}

/**
 * Make the transient-token amountDetails the source of truth for the order's tax/total.
 *
 * The UC widget authorizes the merchant-facing total it computed from the capture-context
 * request (including tax), and echoes it back in the transient token under
 * orderInformation.amountDetails. When SFCC's tax service computes a different value (e.g. a
 * sandbox with no tax provider), the storefront's Order-Confirm Total would not match what was
 * actually charged. This helper distributes the token's taxAmount across the basket's product
 * line items as a per-line tax RATE (SFCC's updateTax interprets its argument as a rate, not a
 * dollar amount), then recomputes basket aggregates via updateTotals() — which, unlike
 * calculateTotals, does NOT re-fire the dw.order.calculateTax hook (calculateAdjustments.js)
 * that would otherwise wipe these per-line values.
 *
 * @param {dw.order.Basket} basket - current basket
 * @param {Object} paymentDetails - decoded response from payments.getPaymentDetails
 * @param {Object} TransactionObj - dw/system/Transaction
 * @returns {boolean} - true if the override was applied, false on any no-op/guard
 */
function applyAmountDetailsFromPaymentDetails(basket, paymentDetails, TransactionObj) {
    if (!paymentDetails || !paymentDetails.orderInformation || !paymentDetails.orderInformation.amountDetails) {
        return false;
    }
    var amountDetails = paymentDetails.orderInformation.amountDetails;
    var tokenTaxAmount = parseFloat(amountDetails.taxAmount);
    var tokenTotalAmount = parseFloat(amountDetails.totalAmount);
    if (isNaN(tokenTaxAmount) || isNaN(tokenTotalAmount)) {
        return false;
    }

    // No churn if the storefront tax already matches the token (within a cent).
    var currentTax = basket.totalTax && basket.totalTax.available ? basket.totalTax.value : 0;
    if (Math.abs(currentTax - tokenTaxAmount) < 0.01) {
        return false;
    }

    var productLineItems = basket.getAllProductLineItems();
    if (!productLineItems || productLineItems.length === 0) {
        logger.warn('applyAmountDetailsFromPaymentDetails: basket has no product line items; cannot distribute tax');
        return false;
    }
    var pliArray = productLineItems.toArray();
    var Money = require('dw/value/Money');
    var currencyCode = basket.currencyCode;

    // Proportional weight base: sum of product-line gross prices.
    var totalGross = 0;
    for (var g = 0; g < pliArray.length; g++) {
        var grossMoney = pliArray[g].adjustedGrossPrice;
        if (grossMoney && grossMoney.available) {
            totalGross += grossMoney.value;
        }
    }
    if (totalGross <= 0) {
        return false;
    }

    TransactionObj.wrap(function () {
        var distributed = 0;
        var largestLine = null;
        var largestGross = -1;
        var largestLineShare = 0;
        var largestLineNet = 0;

        for (var i = 0; i < pliArray.length; i++) {
            var pli = pliArray[i];
            var lineGross = (pli.adjustedGrossPrice && pli.adjustedGrossPrice.available) ? pli.adjustedGrossPrice.value : 0;
            var lineNet = (pli.adjustedNetPrice && pli.adjustedNetPrice.available) ? pli.adjustedNetPrice.value : 0;

            // Per-line dollar share of the token tax, proportional to gross, rounded to cents.
            var share = Math.round((tokenTaxAmount * (lineGross / totalGross)) * 100) / 100;

            // Use the two-arg updateTax(rate, taxBasis) so we supply the basis explicitly:
            // tax = rate * basis = share, regardless of the site's net/gross taxation policy or
            // the "tax on adjusted price" preference (which otherwise make the one-arg basis
            // system-determined and not equal to adjustedNetPrice).
            var rate = lineNet > 0 ? (share / lineNet) : 0;
            pli.updateTax(rate, new Money(lineNet, currencyCode));
            distributed += share;

            if (lineGross > largestGross) {
                largestGross = lineGross;
                largestLine = pli;
                largestLineShare = share;
                largestLineNet = lineNet;
            }
        }

        // Reconcile rounding pennies on the largest line — again via the two-arg form with an
        // explicit basis so the corrected tax equals correctedShare exactly.
        var penny = Math.round((tokenTaxAmount - distributed) * 100) / 100;
        if (penny !== 0 && largestLine && largestLineNet > 0) {
            var correctedShare = largestLineShare + penny;
            largestLine.updateTax(correctedShare / largestLineNet, new Money(largestLineNet, currencyCode));
        }

        // Recompute basket aggregates from line-item state WITHOUT re-firing the calculate hooks.
        basket.updateTotals();
    });

    logger.info('applyAmountDetailsFromPaymentDetails: applied token taxAmount {0}; basket totalGrossPrice now {1}',
        tokenTaxAmount, basket.totalGrossPrice.value);
    return true;
}

// ============================================================================
// Card Type Mapping Functions
// ============================================================================

/**
 * Map CyberSource card type code to readable name
 * @param {string} cardTypeCode - CyberSource card type code (e.g., '001' for Visa)
 * @returns {string} - Readable card type name
 */
function mapCardType(cardTypeCode) {
    if (!cardTypeCode) return '';
    
    var cardTypeMap = {
        '001': 'Visa',
        '002': 'Master Card',
        '003': 'Amex',
        '004': 'Discover',
        '005': 'DinersClub',
        '006': 'Carte Blanche',
        '007': 'JCB',
        '042': 'Maestro',
        '062': 'China UnionPay',
        '036': 'CartesBancaires',
        '054': 'Elo',
        '046': 'JCrew',
        '070': 'EFTPOS',
        '067': 'Meeza',
        '060': 'Mada',
        '058': 'Carnet',
        '081': 'Jaywan'
    };
    
    if (cardTypeMap[cardTypeCode]) {
        return cardTypeMap[cardTypeCode];
    }
    
    var upperCode = cardTypeCode.toString().toUpperCase();
    var nameMap = {
        'VISA': 'Visa',
        'MASTERCARD': 'Master Card',
        'MASTER CARD': 'Master Card',
        'AMEX': 'Amex',
        'AMERICAN EXPRESS': 'Amex',
        'DISCOVER': 'Discover',
        'JCB': 'JCB',
        'DINERS': 'DinersClub',
        'DINERSCLUB': 'DinersClub',
        'MAESTRO': 'Maestro',
        'UNIONPAY': 'China UnionPay'
    };
    
    return nameMap[upperCode] || cardTypeCode;
}

// ============================================================================
// JWT Decoding Functions
// ============================================================================

/**
 * Decode JWT payload (base64url decode)
 * @param {string} token - JWT token string
 * @returns {Object|null} - Decoded payload or null if invalid
 */
function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        var parts = token.split('.');
        if (parts.length !== 3) return null;
        var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        var StringUtils = require('dw/util/StringUtils');
        var jsonPayload = decodeURIComponent(
            StringUtils.decodeBase64(base64).split('').map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join('')
        );
        return JSON.parse(jsonPayload);
    } catch (e) {
        logger.warn('Failed to decode JWT payload: {0}', e.message);
        return null;
    }
}

// ============================================================================
// Payment Method Detection Functions
// ============================================================================

/**
 * Detect payment method from completeMandate JWT.
 *
 * Order of checks:
 * 1. paymentInformation.bank present → BANK_TRANSFER (eCheck has no paymentSolution code)
 * 2. processingInformation.paymentSolution code → DW_GOOGLE_PAY / DW_APPLE_PAY / CLICK_TO_PAY
 * 3. Default → CREDIT_CARD
 *
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @returns {string} - Payment method ID
 */
function detectPaymentMethod(jwtPayload) {
    var details = jwtPayload && jwtPayload.details;
    if (details && details.paymentInformation && details.paymentInformation.bank) {
        return 'BANK_TRANSFER';
    }

    var processingInfo = details && details.processingInformation;
    var paymentSolution = processingInfo && processingInfo.paymentSolution;

    if (paymentSolution === '012') {
        return 'DW_GOOGLE_PAY';
    } else if (paymentSolution === '001') {
        return 'DW_APPLE_PAY';
    } else if (paymentSolution === '027') {
        return 'CLICK_TO_PAY';
    }
    return 'CREDIT_CARD';
}

/**
 * Resolve the processor hook key for a given payment method ID.
 * @param {string} paymentMethodId - SFCC payment method ID (e.g. 'DW_APPLE_PAY')
 * @returns {string|null} - Lower-cased processor ID for use in 'app.payment.processor.<id>'
 */
function getProcessorIdForMethod(paymentMethodId) {
    var PaymentMgr = require('dw/order/PaymentMgr');
    var method = PaymentMgr.getPaymentMethod(paymentMethodId);
    if (!method) return null;
    var processor = method.getPaymentProcessor();
    if (!processor) return null;
    return processor.ID.toLowerCase();
}

/**
 * Extract bank details from a getPaymentDetails API response.
 * @param {Object} paymentDetails - Response from payments.getPaymentDetails(transientToken)
 * @param {Object} [billingAddress] - Optional billing address for accountHolder fallback
 * @returns {Object} - { routingNumber, accountNumber, accountHolder }
 */
function extractBankDetails(paymentDetails, billingAddress) {
    var bank = paymentDetails && paymentDetails.paymentInformation && paymentDetails.paymentInformation.bank;
    var routingNumber = bank && bank.routingNumber ? bank.routingNumber : '';
    var accountNumber = bank && bank.account && bank.account.number ? bank.account.number : '';
    var accountHolder = '';
    if (billingAddress && billingAddress.fullName) {
        accountHolder = billingAddress.fullName;
    }
    return {
        routingNumber: routingNumber,
        accountNumber: accountNumber,
        accountHolder: accountHolder
    };
}

// ============================================================================
// Card Details Extraction Functions
// ============================================================================

/**
 * Extract card details from completeMandate JWT and transient token
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @param {string} transientToken - Transient token from SDK
 * @param {Object} billingAddress - Optional billing address object
 * @returns {Object} - Card details object
 */
function extractCardDetails(jwtPayload, transientToken, billingAddress) {
    var cardDetails = {
        cardTypeCode: '',
        cardTypeName: '',
        maskedNumber: '',
        expirationMonth: '',
        expirationYear: '',
        cardHolderName: ''
    };

    // Get cardholder name from billing address if provided
    if (billingAddress) {
        var firstName = billingAddress.firstName || '';
        var lastName = billingAddress.lastName || '';
        if (firstName || lastName) {
            cardDetails.cardHolderName = (firstName + ' ' + lastName).trim();
        }
    }

    // Get card type from completeMandate JWT
    if (jwtPayload.details && jwtPayload.details.paymentInformation) {
        var paymentInfoJwt = jwtPayload.details.paymentInformation;
        
        if (paymentInfoJwt.card && paymentInfoJwt.card.type) {
            cardDetails.cardTypeCode = paymentInfoJwt.card.type;
        }
        if (!cardDetails.cardTypeCode && paymentInfoJwt.tokenizedCard && paymentInfoJwt.tokenizedCard.type) {
            cardDetails.cardTypeCode = paymentInfoJwt.tokenizedCard.type;
        }
        
        if (paymentInfoJwt.tokenizedCard) {
            cardDetails.expirationMonth = paymentInfoJwt.tokenizedCard.expirationMonth || '';
            cardDetails.expirationYear = paymentInfoJwt.tokenizedCard.expirationYear || '';
        }
        if ((!cardDetails.expirationMonth || !cardDetails.expirationYear) && paymentInfoJwt.card) {
            cardDetails.expirationMonth = cardDetails.expirationMonth || paymentInfoJwt.card.expirationMonth || '';
            cardDetails.expirationYear = cardDetails.expirationYear || paymentInfoJwt.card.expirationYear || '';
        }
    }

    // Get details from transient token
    if (transientToken) {
        var transientPayload = decodeJwtPayload(transientToken);
        if (transientPayload && transientPayload.content && transientPayload.content.paymentInformation) {
            var transientPaymentInfo = transientPayload.content.paymentInformation;

            if (transientPaymentInfo.tokenizedCard && transientPaymentInfo.tokenizedCard.number) {
                var tokenizedNum = transientPaymentInfo.tokenizedCard.number;
                cardDetails.maskedNumber = tokenizedNum.maskedValue || tokenizedNum || '';
            }
            if (!cardDetails.maskedNumber && transientPaymentInfo.card && transientPaymentInfo.card.number) {
                var cardNum = transientPaymentInfo.card.number;
                cardDetails.maskedNumber = cardNum.maskedValue || cardNum || '';
            }
            
            if (!cardDetails.expirationMonth || !cardDetails.expirationYear) {
                if (transientPaymentInfo.card) {
                    var expMonth = transientPaymentInfo.card.expirationMonth;
                    var expYear = transientPaymentInfo.card.expirationYear;
                    cardDetails.expirationMonth = cardDetails.expirationMonth || (expMonth ? expMonth.value || expMonth : '');
                    cardDetails.expirationYear = cardDetails.expirationYear || (expYear ? expYear.value || expYear : '');
                }
                if (transientPaymentInfo.tokenizedCard) {
                    var tokExpMonth = transientPaymentInfo.tokenizedCard.expirationMonth;
                    var tokExpYear = transientPaymentInfo.tokenizedCard.expirationYear;
                    cardDetails.expirationMonth = cardDetails.expirationMonth || (tokExpMonth ? tokExpMonth.value || tokExpMonth : '');
                    cardDetails.expirationYear = cardDetails.expirationYear || (tokExpYear ? tokExpYear.value || tokExpYear : '');
                }
            }
            
            if (!cardDetails.cardTypeCode && transientPaymentInfo.card && transientPaymentInfo.card.type) {
                cardDetails.cardTypeCode = transientPaymentInfo.card.type.value || transientPaymentInfo.card.type || '';
            }
            if (!cardDetails.cardTypeCode && transientPaymentInfo.tokenizedCard && transientPaymentInfo.tokenizedCard.type) {
                cardDetails.cardTypeCode = transientPaymentInfo.tokenizedCard.type.value || transientPaymentInfo.tokenizedCard.type || '';
            }
        }
    }

    cardDetails.cardTypeName = mapCardType(cardDetails.cardTypeCode);
    return cardDetails;
}

/**
 * Build payment details string for display
 * @param {Object} cardDetails - Card details object
 * @returns {string} - Formatted payment details string
 */
function buildPaymentDetailsString(cardDetails) {
    if (cardDetails.maskedNumber && cardDetails.cardTypeName) {
        return cardDetails.maskedNumber + ', ' + cardDetails.cardTypeName;
    } else if (cardDetails.maskedNumber) {
        return cardDetails.maskedNumber;
    } else if (cardDetails.cardTypeName) {
        return cardDetails.cardTypeName;
    }
    return '';
}

/**
 * Update payment instrument with card details
 * @param {dw.order.PaymentInstrument} paymentInstrument - Payment instrument to update
 * @param {Object} cardDetails - Card details object
 * @param {boolean} isDigitalWallet - Whether payment is from Google Pay or Apple Pay
 */
function updatePaymentInstrumentCardDetails(paymentInstrument, cardDetails, isDigitalWallet) {
    if (cardDetails.cardHolderName && (isDigitalWallet || !paymentInstrument.creditCardHolder)) {
        paymentInstrument.setCreditCardHolder(cardDetails.cardHolderName);
    }
    if (cardDetails.maskedNumber && (isDigitalWallet || !paymentInstrument.creditCardNumber)) {
        paymentInstrument.setCreditCardNumber(cardDetails.maskedNumber);
    }
    if (cardDetails.cardTypeName && (isDigitalWallet || !paymentInstrument.creditCardType)) {
        paymentInstrument.setCreditCardType(cardDetails.cardTypeName);
    }
    if (cardDetails.expirationMonth && (isDigitalWallet || !paymentInstrument.creditCardExpirationMonth)) {
        paymentInstrument.setCreditCardExpirationMonth(parseInt(cardDetails.expirationMonth, 10));
    }
    if (cardDetails.expirationYear && (isDigitalWallet || !paymentInstrument.creditCardExpirationYear)) {
        paymentInstrument.setCreditCardExpirationYear(parseInt(cardDetails.expirationYear, 10));
    }
}

// ============================================================================
// Transaction Custom Attribute Functions
// ============================================================================

/**
 * Safely set custom attribute on payment transaction
 * @param {dw.order.PaymentTransaction} paymentTransaction - Payment transaction
 * @param {string} attributeName - Custom attribute name
 * @param {*} value - Value to set
 * @returns {boolean} - True if attribute was set
 */
function setTransactionCustomAttribute(paymentTransaction, attributeName, value) {
    if (!value) return false;
    try {
        if (attributeName in paymentTransaction.custom) {
            paymentTransaction.custom[attributeName] = value;
            return true;
        }
    } catch (e) {
        logger.debug('Custom attribute {0} not available on PaymentTransaction', attributeName);
    }
    return false;
}

// ============================================================================
// Authorization Status Functions
// ============================================================================

/**
 * Check if authorization/capture status is valid for order placement
 * Handles both AUTH and CAPTURE (sale) transaction types
 * 
 * AUTH statuses:
 * - AUTHORIZED: Authorization successful
 * - AUTHORIZED_PENDING_REVIEW: Authorization successful, pending fraud review
 * 
 * CAPTURE (sale) statuses:
 * - CAPTURED: Capture/sale successful
 * - PARTIAL_CAPTURED: Partial capture successful
 * - PENDING: Transaction pending (some capture flows)
 * 
 * @param {string} status - Status from completeMandate JWT
 * @returns {boolean} - True if status is valid for order placement
 */
function isValidAuthorizationStatus(status) {
    var validStatuses = [
        // AUTH statuses
        'AUTHORIZED',
        'AUTHORIZED_PENDING_REVIEW',
        // CAPTURE (sale) statuses
        'CAPTURED',
        'PARTIAL_CAPTURED',
        'PENDING'
    ];
    return validStatuses.indexOf(status) !== -1;
}

/**
 * Get error message based on authorization status
 * @param {string} status - Authorization status
 * @returns {string} - Error message
 */
function getAuthorizationErrorMessage(status) {
    var Resource = require('dw/web/Resource');
    if (status === 'DECLINED') {
        return Resource.msg('error.payment.declined', 'error', null);
    } else if (status === 'AUTHORIZED_RISK_DECLINED') {
        return Resource.msg('error.payment.risk.declined', 'error', null);
    }
    return Resource.msg('message.error.card.not.authorized', 'error', null);
}

// ============================================================================
// Capture Context Builder Functions
// ============================================================================

/**
 * Build billTo object from basket billing address
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Object|null} - billTo object or null
 */
function buildBillToAddress(basket) {
    var billingAddress = basket.billingAddress;
    if (!billingAddress) return null;

    // UC v1 (ISV Phase 1): match the canonical billTo shape from Dan's reference payload —
    // firstName, lastName, email, address1, address2, locality, administrativeArea, postalCode,
    // country, phoneNumber, phoneType.
    var billTo = {
        firstName: billingAddress.firstName || '',
        lastName: billingAddress.lastName || '',
        email: basket.customerEmail || '',
        address1: billingAddress.address1 || '',
        address2: billingAddress.address2 || '',
        locality: billingAddress.city || '',
        administrativeArea: billingAddress.stateCode || '',
        postalCode: billingAddress.postalCode || '',
        country: billingAddress.countryCode ? billingAddress.countryCode.value.toUpperCase() : '',
        phoneNumber: billingAddress.phone || ''
    };
    if (billTo.phoneNumber) {
        billTo.phoneType = 'work';
    }
    return billTo;
}

/**
 * Build shipTo object from basket shipping address
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Object|null} - shipTo object or null
 */
function buildShipToAddress(basket) {
    var defaultShipment = basket.defaultShipment;
    var shippingAddress = defaultShipment ? defaultShipment.shippingAddress : null;
    if (!shippingAddress) return null;

    // UC v1 (ISV Phase 1): match Dan's reference payload — shipTo carries the address and
    // recipient name only. No phoneNumber, no email.
    return {
        firstName: shippingAddress.firstName || '',
        lastName: shippingAddress.lastName || '',
        address1: shippingAddress.address1 || '',
        address2: shippingAddress.address2 || '',
        locality: shippingAddress.city || '',
        administrativeArea: shippingAddress.stateCode || '',
        postalCode: shippingAddress.postalCode || '',
        country: shippingAddress.countryCode ? shippingAddress.countryCode.value.toUpperCase() : ''
    };
}

/**
 * Get the number of decimal places for a currency from BM configuration
 * Uses SFCC Currency API which reads from BM > Merchant Tools > Ordering > Currencies
 * @param {string} currencyCode - ISO 4217 currency code
 * @returns {number} - Number of decimal places (0, 2, or 3)
 */
function getCurrencyDecimalPlaces(currencyCode) {
    if (!currencyCode) return 2;
    
    var Currency = require('dw/util/Currency');
    
    try {
        var currency = Currency.getCurrency(currencyCode);
        if (currency) {
            return currency.getDefaultFractionDigits();
        }
    } catch (e) {
        logger.warn('getCurrencyDecimalPlaces: Error getting currency {0} - {1}', currencyCode, e.message);
    }
    
    // Default fallback if currency not found in BM
    return 2;
}

/**
 * Format amount with proper decimal places for currency
 * Uses BM currency configuration for decimal places (ISO 4217 compliant)
 * @param {number} amount - Amount value
 * @param {string} [currencyCode] - ISO 4217 currency code (defaults to 2 decimals if not provided)
 * @returns {string} - Formatted amount string
 */
function formatAmount(amount, currencyCode) {
    var decimals = getCurrencyDecimalPlaces(currencyCode);
    
    if (amount === null || amount === undefined) {
        return decimals === 0 ? '0' : Number(0).toFixed(decimals);
    }
    
    return decimals === 0 ? String(Math.round(Number(amount))) : Number(amount).toFixed(decimals);
}

/**
 * Build line items array from basket for capture context
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Array} - Array of line item objects
 */
function buildLineItems(basket) {
    var lineItems = [];
    var allLineItems = basket.allLineItems;
    var currencyCode = basket.currencyCode;

    if (!allLineItems) return lineItems;

    for (var i = 0; i < allLineItems.length; i++) {
        var lineItem = allLineItems[i];
        var itemObject = null;

        if (lineItem instanceof dw.order.ProductLineItem) {
            // UC v1 (ISV Phase 1): canonical line-item shape. typeOfSupply '00' = goods.
            var product = lineItem.product;
            var productDescription = '';
            if (product && product.shortDescription) {
                productDescription = product.shortDescription.markup || '';
            }
            if (!productDescription) {
                productDescription = lineItem.productName || '';
            }
            itemObject = {
                productSku: lineItem.productID || '',
                productName: lineItem.productName || '',
                productDescription: productDescription,
                quantity: lineItem.quantityValue,
                unitPrice: formatAmount(lineItem.basePrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '00',
                taxAmount: formatAmount(lineItem.adjustedTax.value > 0 ? lineItem.adjustedTax.value : 0, currencyCode)
            };

            if (lineItem.proratedPrice && lineItem.proratedPrice.value > 0) {
                itemObject.unitPrice = formatAmount(lineItem.proratedPrice.value / lineItem.quantityValue, currencyCode);
                itemObject.totalAmount = formatAmount(lineItem.proratedPrice.value, currencyCode);
            }
        } else if (lineItem instanceof dw.order.GiftCertificateLineItem) {
            // typeOfSupply '00' = goods.
            itemObject = {
                productSku: 'GIFT_CERTIFICATE',
                productName: 'GIFT_CERTIFICATE',
                productDescription: 'GIFT_CERTIFICATE',
                quantity: 1,
                unitPrice: formatAmount(lineItem.adjustedPrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '00',
                taxAmount: formatAmount(0, currencyCode)
            };
        } else if (lineItem instanceof dw.order.ShippingLineItem) {
            if (lineItem.adjustedPrice.value === 0) {
                continue;
            }
            // typeOfSupply '01' = shipping/services.
            itemObject = {
                productSku: lineItem.ID || 'SHIPPING',
                productName: lineItem.ID || 'SHIPPING',
                productDescription: 'SHIPPING',
                quantity: 1,
                unitPrice: formatAmount(lineItem.adjustedPrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '01'
            };
            if (lineItem.adjustedTax && lineItem.adjustedTax.value > 0) {
                itemObject.taxAmount = formatAmount(lineItem.adjustedTax.value, currencyCode);
            }
        } else if (lineItem instanceof dw.order.ProductShippingLineItem) {
            // typeOfSupply '01' = shipping/services.
            itemObject = {
                productSku: 'SHIPPING_SURCHARGE',
                productName: 'SHIPPING_SURCHARGE',
                productDescription: 'SHIPPING_SURCHARGE',
                quantity: 1,
                unitPrice: formatAmount(lineItem.adjustedPrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '01',
                taxAmount: formatAmount(lineItem.adjustedTax ? lineItem.adjustedTax.value : 0, currencyCode)
            };
        }

        if (itemObject) {
            lineItems.push(itemObject);
        }
    }

    return lineItems;
}

/**
 * Build completeMandate object based on configuration
 * 
 * UC v1: Only TMS tokenTypes configuration is passed.
 * Other configuration (type, decisionManager, tms.tokenCreate, consumerAuthentication)
 * is managed via EBC (Enterprise Business Center) and should NOT be overridden.
 * 
 * Available tokenTypes:
 * - customer: Creates a TMS customer token
 * - paymentInstrument: Creates a payment instrument token
 * - instrumentIdentifier: Creates an instrument identifier token
 * - shippingAddress: Creates a shipping address token
 * 
 * @param {Object} configObject - Configuration object from BM (unused in UC v1)
 * @param {boolean} isTokenizationEnabled - Whether tokenization is enabled (unused in UC v1)
 * @param {boolean} isRegisteredCustomer - Whether customer is registered (unused in UC v1)
 * @param {dw.customer.Customer} customer - Customer object (unused in UC v1)
 * @returns {Object} - completeMandate object with TMS tokenTypes
 */
function buildCompleteMandate(configObject, isTokenizationEnabled, isRegisteredCustomer, customer) {
    // UC v1: Return completeMandate with TMS tokenTypes
    // tokenTypes specifies which tokens to create when cardholder opts to save card
    return {
        tms: {
            tokenTypes: ['customer', 'paymentInstrument', 'instrumentIdentifier']
        }
    };
}

/**
 * Build orderInformation object for capture context
 * @param {dw.order.Basket} basket - Current basket
 * @param {boolean} isMiniCart - Whether this is minicart flow
 * @returns {Object} - orderInformation object
 */
function buildOrderInformation(basket, isMiniCart) {
    var currencyCode = basket.currencyCode;
    // UC v1 (ISV Phase 1): mirror canonical amountDetails — totalAmount, currency, taxAmount.
    var totalTax = basket.totalTax && basket.totalTax.value > 0 ? basket.totalTax.value : 0;
    var orderInformation = {
        amountDetails: {
            totalAmount: formatAmount(basket.totalGrossPrice.value, currencyCode),
            currency: currencyCode,
            taxAmount: formatAmount(totalTax, currencyCode)
        }
    };

    if (!isMiniCart) {
        var billTo = buildBillToAddress(basket);
        if (billTo) {
            orderInformation.billTo = billTo;
        }

        var shipTo = buildShipToAddress(basket);
        if (shipTo) {
            orderInformation.shipTo = shipTo;
        }
    }

    var lineItems = buildLineItems(basket);
    if (lineItems.length > 0) {
        orderInformation.lineItems = lineItems;
    }

    return orderInformation;
}

// ============================================================================
// TMS Token Saving Functions
// ============================================================================

/**
 * Check if user opted to save card in UC completeMandate response
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @returns {boolean} - True if tokenInformation exists
 */
function didUserRequestSaveCard(jwtPayload) {
    return !!(jwtPayload.details && jwtPayload.details.tokenInformation);
}

/**
 * Extract token information from completeMandate JWT response
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @returns {Object|null} - Token information object or null
 */
function extractTokenInformation(jwtPayload) {
    if (!jwtPayload.details || !jwtPayload.details.tokenInformation) {
        return null;
    }
    return jwtPayload.details.tokenInformation;
}

/**
 * Find an existing saved credit card that belongs to the given CyberSource
 * instrumentIdentifier. The serialized token always begins with the
 * instrumentIdentifier id ("<iid>-<piid>-flex[-<customerId>]"), so a card matches
 * when the FIRST hyphen-separated segment of its token equals that id. Using the
 * exact segment (rather than a string prefix) avoids false matches between ids where
 * one is a prefix of another.
 * @param {dw.customer.Wallet} wallet - customer wallet
 * @param {string} instrumentIdentifierId - CyberSource instrumentIdentifier id
 * @returns {dw.customer.CustomerPaymentInstrument|null} matching card or null
 */
function findCreditCardByInstrumentIdentifier(wallet, instrumentIdentifierId) {
    if (!wallet || !instrumentIdentifierId) {
        return null;
    }
    var paymentInstruments = wallet.getPaymentInstruments().toArray();
    for (var i = 0; i < paymentInstruments.length; i++) {
        var pi = paymentInstruments[i];
        var existingToken = pi.creditCardToken;
        if (existingToken && existingToken.split('-')[0] === instrumentIdentifierId) {
            return pi;
        }
    }
    return null;
}

/**
 * Saves a tokenized credit card to the wallet, de-duplicating by instrumentIdentifier.
 *
 * SFCC permanently masks a persisted CustomerPaymentInstrument; once masked, its card
 * setters throw "Payment Instrument Info attributes are already masked permanently". So
 * when a card with the same instrumentIdentifier already exists we REPLACE it (create a
 * fresh instrument, then remove the old one) inside a single transaction — rather than
 * mutating the masked record — carrying over any missing details and the default
 * (custom.isDefault) flag.
 *
 * @param {dw.customer.Wallet} wallet - customer wallet
 * @param {string} serializedToken - serialized TMS token to store
 * @param {Object} cardDetails - { cardHolderName, cardTypeName, maskedNumber, expirationMonth, expirationYear }
 * @param {string} instrumentIdentifierId - CyberSource instrumentIdentifier id
 * @returns {Object} { uuid: <saved card UUID>, replacedExisting: <boolean> }
 */
function upsertCreditCard(wallet, serializedToken, cardDetails, instrumentIdentifierId) {
    var dwOrderPaymentInstrument = require('dw/order/PaymentInstrument');
    var details = cardDetails || {};
    var existingPI = findCreditCardByInstrumentIdentifier(wallet, instrumentIdentifierId);

    var wasDefault = false;
    var holder = details.cardHolderName;
    var type = details.cardTypeName;
    var masked = details.maskedNumber;
    var expMonth = details.expirationMonth;
    var expYear = details.expirationYear;

    if (existingPI) {
        // Getters are safe on a masked instrument; carry over anything the new details
        // don't provide so the replacement record stays complete.
        try {
            wasDefault = !!(existingPI.custom && existingPI.custom.isDefault);
        } catch (e) {
            wasDefault = false;
        }
        holder = holder || existingPI.creditCardHolder;
        type = type || existingPI.creditCardType;
        masked = masked || existingPI.maskedCreditCardNumber;
        expMonth = expMonth || existingPI.creditCardExpirationMonth;
        expYear = expYear || existingPI.creditCardExpirationYear;
    }

    var savedUUID = null;
    Transaction.wrap(function () {
        var newPI = wallet.createPaymentInstrument(dwOrderPaymentInstrument.METHOD_CREDIT_CARD);
        if (holder) { newPI.setCreditCardHolder(holder); }
        if (type) { newPI.setCreditCardType(type); }
        if (masked) { newPI.setCreditCardNumber(masked); }
        if (expMonth) { newPI.setCreditCardExpirationMonth(parseInt(expMonth, 10)); }
        if (expYear) { newPI.setCreditCardExpirationYear(parseInt(expYear, 10)); }
        newPI.setCreditCardToken(serializedToken);
        if (wasDefault) {
            newPI.custom.isDefault = true;
        }
        if (existingPI) {
            wallet.removePaymentInstrument(existingPI);
        }
        savedUUID = newPI.UUID;
    });

    return { uuid: savedUUID, replacedExisting: !!existingPI };
}

/**
 * Save TMS token to customer wallet from completeMandate response
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @param {Object} cardDetails - Card details object
 * @param {dw.customer.Customer} customer - Customer object
 * @returns {boolean} - True if token was saved successfully
 */
function saveTokenToWallet(jwtPayload, cardDetails, customer) {
    if (!didUserRequestSaveCard(jwtPayload)) {
        logger.debug('saveTokenToWallet: User did not opt to save card');
        return false;
    }

    if (!customer || !customer.isAuthenticated() || !customer.getProfile()) {
        logger.debug('saveTokenToWallet: Customer not authenticated');
        return false;
    }

    var tokenInfo = extractTokenInformation(jwtPayload);
    if (!tokenInfo) {
        logger.debug('saveTokenToWallet: No token information in JWT response');
        return false;
    }

    if (!tokenInfo.paymentInstrument || !tokenInfo.paymentInstrument.id ||
        !tokenInfo.instrumentIdentifier || !tokenInfo.instrumentIdentifier.id) {
        logger.warn('saveTokenToWallet: Missing required token fields');
        return false;
    }

    var CustomerMgr = require('dw/customer/CustomerMgr');
    var TRLHelper = require('~/cartridge/scripts/helpers/tokenRateLimiterHelper.js');

    try {
        var profile = customer.getProfile();
        var customerObj = CustomerMgr.getCustomerByCustomerNumber(profile.customerNo);

        var isAllowed = TRLHelper.IsCustumerAllowedSinglePaymentInstrumentInsertion(customerObj);
        if (!isAllowed.result) {
            logger.warn('saveTokenToWallet: Rate limiter rejected');
            return false;
        }

        var wallet = customerObj.profile.wallet;

        var serializedToken;
        if (tokenInfo.customer && tokenInfo.customer.id) {
            serializedToken = [
                tokenInfo.instrumentIdentifier.id,
                tokenInfo.paymentInstrument.id,
                'flex',
                tokenInfo.customer.id
            ].join('-');

            Transaction.wrap(function () {
                if (!profile.custom.customerID) {
                    profile.custom.customerID = tokenInfo.customer.id;
                }
            });
        } else {
            serializedToken = [
                tokenInfo.instrumentIdentifier.id,
                tokenInfo.paymentInstrument.id,
                'flex'
            ].join('-');
        }

        var upsertResult = upsertCreditCard(wallet, serializedToken, cardDetails, tokenInfo.instrumentIdentifier.id);
        logger.info('saveTokenToWallet: Card {0}. InstrumentIdentifier: {1}',
            upsertResult.replacedExisting ? 'updated (replaced)' : 'saved', tokenInfo.instrumentIdentifier.id);

        // Only a brand-new card counts against the rate limiter (a replace is not a new insertion).
        if (!upsertResult.replacedExisting) {
            if (isAllowed.resetTimer) {
                TRLHelper.resetTimer(customerObj);
            }
            if (isAllowed.increaseCounter) {
                TRLHelper.increaseCounter(customerObj);
            }
        }

        return true;
    } catch (e) {
        logger.error('saveTokenToWallet: Error saving token - {0}', e.message || e);
        return false;
    }
}

// ============================================================================
// Shipping Method Helper Functions
// ============================================================================

/**
 * Set default shipping method on basket if not present
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} TransactionObj - DW Transaction object
 */
function setDefaultShippingMethod(basket, TransactionObj) {
    var ShippingMgr = require('dw/order/ShippingMgr');
    var shipment = basket.getDefaultShipment();
    
    if (!shipment.shippingMethod) {
        var defaultMethod = ShippingMgr.getDefaultShippingMethod();
        if (defaultMethod) {
            TransactionObj.wrap(function () {
                shipment.setShippingMethod(defaultMethod);
            });
            logger.info('setDefaultShippingMethod: Default shipping method set: {0}', defaultMethod.ID);
        }
    }
}

/**
 * Build deviceInformation object for Capture Context API
 * Per CyberSource documentation, the capture context deviceInformation only supports ipAddress.
 * Other device fields (httpAcceptContent, userAgentBrowserValue, deviceChannel, etc.) are meant
 * for 3DS payer authentication during payment authorization, not capture context generation.
 * 
 * @returns {Object} - deviceInformation object with ipAddress only
 */
function buildCaptureContextDeviceInformation() {
    return {
        ipAddress: request.httpRemoteAddress
    };
}

/**
 * Build consumerAuthenticationInformation object for Capture Context API
 * 
 * Handles SCA (Strong Customer Authentication) challenge code behavior:
 * - When an SCA-required outcome (e.g., response 478) occurred previously,
 *   challengeCode = '04' is included to mandate challenge on retry
 * - Default challengeCode is '01' (no preference) when payer auth is enabled
 * 
 * Challenge Code Values:
 * - 01: No preference (default)
 * - 04: Challenge mandated - SCA required
 * 
 * @param {Object} configObject - Configuration object from BM
 * @returns {Object|null} - consumerAuthenticationInformation object or null if payer auth is disabled
 */
function buildConsumerAuthenticationInformation(configObject) {
    // Check if payer authentication is enabled
    var payerAuthSetting = (configObject.payerAuthenticationEnabled || '').toString().toUpperCase();
    if (payerAuthSetting !== 'YES' && payerAuthSetting !== 'DATA_ONLY_YES' && payerAuthSetting !== 'DATA_ONLY_NO') {
        return null;
    }

    // Only return challengeCode if SCA was required (session flag set by failed auth)
    if (session.privacy.scaRequired) {
        var consumerAuthInfo = { challengeCode: '04' };
        logger.info('buildConsumerAuthenticationInformation: SCA required flag detected, setting challengeCode=04');
        // Clear the flag after using it (one-time use per retry)
        session.privacy.scaRequired = false;
        return consumerAuthInfo;
    }
    // Otherwise, omit the field entirely
    return null;
}

/**
 * Set SCA required flag in session
 * Call this when a 478/SCA-required response is received to trigger
 * challengeCode=04 on the next capture context generation
 */
function setSCARequiredFlag() {
    session.privacy.scaRequired = true;
    logger.info('setSCARequiredFlag: SCA required flag set for next capture context');
}

/**
 * Check if SCA was required (without clearing the flag)
 * @returns {boolean} - True if SCA was required on previous attempt
 */
function isSCARequired() {
    return !!session.privacy.scaRequired;
}

/**
 * Get SCA error message for cardholder display
 * @returns {string} - Localized error message for SCA requirement
 */
function getSCAErrorMessage() {
    var Resource = require('dw/web/Resource');
    return Resource.msg('error.sca.required', 'error', 
        'Your card issuer requires an extra security check to approve this payment. Please try again and follow the verification steps.');
}

/**
 * Build DDC backup device information for Payer Authentication
 * These fields are collected server-side as backup for 3DS device data collection
 * Required fields per specification:
 * - IP address
 * - Browser navigator.javaEnabled
 * - Accept header
 * - Browser language (IETF BCP47)
 * - Screen colour depth, height, width
 * - Browser time difference
 * - User-Agent header
 * - Transaction channel
 * - Browser ability to execute JavaScript
 * 
 * NOTE: These fields are for payment authorization requests, NOT capture context.
 * For capture context, use buildCaptureContextDeviceInformation() which only includes ipAddress.
 * 
 * @param {Object} configObject - Configuration object from BM
 * @param {Object} browserData - Optional browser data collected from client
 * @returns {Object|null} - deviceInformation object or null if payer auth is disabled
 */
function buildDdcBackupDeviceInformation(configObject, browserData) {
    var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');
    
    // Check if payer authentication is enabled
    var payerAuthSetting = (configObject.payerAuthenticationEnabled || '').toString().toUpperCase();
    if (payerAuthSetting !== 'YES' && payerAuthSetting !== 'DATA_ONLY_YES' && payerAuthSetting !== 'DATA_ONLY_NO') {
        return null;
    }

    var deviceInformation = {};

    // Server-side collected fields
    deviceInformation.ipAddress = request.httpRemoteAddress;
    deviceInformation.httpAcceptContent = secureResponseHelper.sanitizeHttpHeader(request.httpHeaders.get('accept'));
    deviceInformation.userAgentBrowserValue = secureResponseHelper.sanitizeHttpHeader(request.httpHeaders.get('user-agent'));
    deviceInformation.deviceChannel = 'Browser';

    // Client-side collected fields (if provided)
    if (browserData) {
        if (browserData.httpBrowserJavaEnabled !== undefined) {
            deviceInformation.httpBrowserJavaEnabled = browserData.httpBrowserJavaEnabled;
        }
        if (browserData.httpBrowserLanguage) {
            deviceInformation.httpBrowserLanguage = browserData.httpBrowserLanguage;
        }
        if (browserData.httpBrowserColorDepth) {
            deviceInformation.httpBrowserColorDepth = String(browserData.httpBrowserColorDepth);
        }
        if (browserData.httpBrowserScreenHeight) {
            deviceInformation.httpBrowserScreenHeight = String(browserData.httpBrowserScreenHeight);
        }
        if (browserData.httpBrowserScreenWidth) {
            deviceInformation.httpBrowserScreenWidth = String(browserData.httpBrowserScreenWidth);
        }
        if (browserData.httpBrowserTimeDifference !== undefined) {
            deviceInformation.httpBrowserTimeDifference = String(browserData.httpBrowserTimeDifference);
        }
        if (browserData.httpBrowserJavaScriptEnabled !== undefined) {
            deviceInformation.httpBrowserJavaScriptEnabled = browserData.httpBrowserJavaScriptEnabled;
        }
    }

    return deviceInformation;
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
    // Token processing
    processUCToken: processUCToken,
    populateBasketAddresses: populateBasketAddresses,
    updateViewDataFromForm: updateViewDataFromForm,
    populateBasketAddressesFromPaymentDetails: populateBasketAddressesFromPaymentDetails,
    applyAmountDetailsFromPaymentDetails: applyAmountDetailsFromPaymentDetails,

    // Card type mapping
    mapCardType: mapCardType,
    
    // JWT decoding
    decodeJwtPayload: decodeJwtPayload,
    
    // Payment method detection
    detectPaymentMethod: detectPaymentMethod,
    getProcessorIdForMethod: getProcessorIdForMethod,
    extractBankDetails: extractBankDetails,

    // Card details extraction
    extractCardDetails: extractCardDetails,
    buildPaymentDetailsString: buildPaymentDetailsString,
    updatePaymentInstrumentCardDetails: updatePaymentInstrumentCardDetails,
    
    // Transaction custom attributes
    setTransactionCustomAttribute: setTransactionCustomAttribute,
    
    // Authorization status
    isValidAuthorizationStatus: isValidAuthorizationStatus,
    getAuthorizationErrorMessage: getAuthorizationErrorMessage,
    
    // Capture context builders
    buildBillToAddress: buildBillToAddress,
    buildShipToAddress: buildShipToAddress,
    buildLineItems: buildLineItems,
    buildCompleteMandate: buildCompleteMandate,
    buildOrderInformation: buildOrderInformation,
    buildCaptureContextDeviceInformation: buildCaptureContextDeviceInformation,
    buildConsumerAuthenticationInformation: buildConsumerAuthenticationInformation,
    buildDdcBackupDeviceInformation: buildDdcBackupDeviceInformation,
    
    // SCA (Strong Customer Authentication) handling
    setSCARequiredFlag: setSCARequiredFlag,
    isSCARequired: isSCARequired,
    getSCAErrorMessage: getSCAErrorMessage,
    
    // Currency formatting
    getCurrencyDecimalPlaces: getCurrencyDecimalPlaces,
    formatAmount: formatAmount,
    
    // TMS token saving
    didUserRequestSaveCard: didUserRequestSaveCard,
    extractTokenInformation: extractTokenInformation,
    findCreditCardByInstrumentIdentifier: findCreditCardByInstrumentIdentifier,
    upsertCreditCard: upsertCreditCard,
    saveTokenToWallet: saveTokenToWallet,
    
    // Shipping method
    setDefaultShippingMethod: setDefaultShippingMethod
};
