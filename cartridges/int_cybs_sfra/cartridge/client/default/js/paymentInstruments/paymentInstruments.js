'use strict';

var base = require('base/paymentInstruments/paymentInstruments');

var baseSubmitPayment = base.submitPayment;

base.submitPayment = function () {
    baseSubmitPayment();
};

/**
 * Shows a warning inside the delete-payment modal. The base modal
 * (app_storefront_base/account/payment/deletePaymentModal.isml) is read-only, so we
 * inject/reuse a warning node in its body rather than editing the template.
 * @param {jQuery} $modal - the delete-payment modal element
 * @param {string} message - the warning text to display
 */
function showModalWarning($modal, message) {
    var $warning = $modal.find('.default-payment-delete-warning');
    if (!$warning.length) {
        $warning = $('<p class="default-payment-delete-warning text-danger"></p>');
        $modal.find('.delete-confirmation-body').append($warning);
    }
    $warning.text(message).removeClass('d-none');
}

/**
 * Clears any previously shown warning and re-enables the confirm button.
 * @param {jQuery} $modal - the delete-payment modal element
 */
function resetModalWarning($modal) {
    $modal.find('.default-payment-delete-warning').addClass('d-none').empty();
    $modal.find('.delete-confirmation-btn').prop('disabled', false);
}

/**
 * Overrides base.removePayment to protect the default saved card.
 *
 * When the shopper tries to delete the default card while other saved cards remain,
 * we block the delete and prompt them to set another card as default first, rather
 * than silently promoting an arbitrary card. This mirrors the authoritative guard in
 * the PaymentInstruments-DeletePayment controller (defence in depth).
 */
base.removePayment = function () {
    $('.remove-payment').on('click', function (e) {
        e.preventDefault();

        var $btn = $(this);
        var $modal = $('#deletePaymentModal');
        var $confirmBtn = $('.delete-confirmation-btn');

        // jQuery coerces the data-default attribute to a boolean; tolerate both.
        var isDefault = $btn.data('default') === true || $btn.data('default') === 'true';
        var cardCount = $('.remove-payment').length;

        resetModalWarning($modal);
        $('.payment-to-remove').empty().append($btn.data('card'));

        // Block deleting the default card while other cards exist.
        if (isDefault && cardCount > 1) {
            showModalWarning($modal, $btn.data('defaultWarning'));
            $confirmBtn.prop('disabled', true);
            return;
        }

        var url = $btn.data('url') + '?UUID=' + $btn.data('id');

        // Rebind (not stack) the confirm handler for the currently targeted card.
        $confirmBtn.off('click.removePayment').on('click.removePayment', function (f) {
            f.preventDefault();
            $('.remove-payment').trigger('payment:remove', f);
            $.ajax({
                url: url,
                type: 'get',
                dataType: 'json',
                success: function (data) {
                    // Server-side guard fallback: surface the warning, keep the card.
                    if (data && data.error) {
                        showModalWarning($modal, data.message);
                        return;
                    }
                    $('#uuid-' + data.UUID).remove();
                    if (data.message) {
                        var toInsert = '<div class="row justify-content-center h3 no-saved-payments"><p>'
                            + data.message
                            + '</p></div>';
                        $('.paymentInstruments').empty().append(toInsert);
                    }
                },
                error: function (err) {
                    if (err.responseJSON && err.responseJSON.redirectUrl) {
                        window.location.href = err.responseJSON.redirectUrl;
                    } else if (err.responseJSON && err.responseJSON.message) {
                        showModalWarning($modal, err.responseJSON.message);
                    }
                    $.spinner().stop();
                }
            });
        });
    });
};

module.exports = base;
