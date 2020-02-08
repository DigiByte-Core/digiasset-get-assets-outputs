const assetIdencoder = require('digiasset-assetid-encoder')
const debug = require('debug')('digiasset-get-assets-outputs')
const _ = require('lodash')

module.exports = function (raw_transaction) {
  const transaction_data = JSON.parse(JSON.stringify(raw_transaction));
  const dadata = transaction_data.dadata[0];
  const assets = [];
  if (dadata.type === 'issuance') {
    transaction_data.vin[0].assets = transaction_data.vin[0].assets || [];
    transaction_data.vin[0].assets.unshift({
      assetId: assetIdencoder(transaction_data),
      amount: dadata.amount,
      issueTxid: transaction_data.txid,
      divisibility: dadata.divisibility,
      lockStatus: dadata.lockStatus,
      aggregationPolicy: dadata.aggregationPolicy
    });
  }

  const payments = dadata.payments;
  const overflow = !transfer(assets, payments, transaction_data);
  if (overflow) {
    // transfer failed. transfer all assets in inputs to last output, aggregate those possible
    assets.length = 0;
    transferToLastOutput(assets, transaction_data.vin, transaction_data.vout.length - 1);
  }

  raw_transaction.overflow = overflow;

  return assets;
}

// returns true if succeeds to apply payments to the given assets array, false if runs into an invalid payment
function transfer (assets, payments, transaction_data) {
  debug('transfer');
  const _payments = _.cloneDeep(payments);
  const _inputs = _.cloneDeep(transaction_data.vin);
  let currentInputIndex = 0;
  let currentAssetIndex = 0;
  let payment;
  let currentAsset;
  let currentAmount;
  let lastPaymentIndex;   // aggregate only if paying the same payment
  for (let i = 0; i < _payments.length; i++) {
    payment = _payments[i];
    debug('payment = ', payment)
    if (!isPaymentSimple(payment)) {
      return false;
    }

    if (payment.input >= transaction_data.vin.length) {
      return false;
    }

    if (payment.output >= transaction_data.vout.length) {
      return false;
    }

    if (!payment.amount) {
      debug('payment.amount === 0 before paying it, continue')
      continue;
    }

    if (currentInputIndex < payment.input) {
      currentInputIndex = payment.input;
      currentAssetIndex = 0;
    }

    if (currentInputIndex >= _inputs.length || !_inputs[currentInputIndex].assets || currentAssetIndex >= _inputs[currentInputIndex].assets.length || !_inputs[currentInputIndex].assets[currentAssetIndex]) {
      debug('no asset in input #' + currentInputIndex + ' asset #' + currentAssetIndex + ', overflow');
      return false;
    }

    currentAsset = _inputs[currentInputIndex].assets[currentAssetIndex];
    currentAmount = Math.min(payment.amount, currentAsset.amount);
    debug('paying ' + currentAmount + ' ' + currentAsset.assetId + ' from input #' + currentInputIndex + ' asset #' + currentAssetIndex + ' to output #' + payment.output);

    if (!payment.burn) {
      assets[payment.output] = assets[payment.output] || [];
      debug('assets[' + payment.output + '] = ', assets[payment.output]);
      if (lastPaymentIndex === i) {
        if (!assets[payment.output].length || assets[payment.output][assets[payment.output].length - 1].assetId !== currentAsset.assetId || currentAsset.aggregationPolicy !== 'aggregatable') {
          debug('tried to pay same payment with a separate asset, overflow');
          return false;
        }
        debug('aggregating ' + currentAmount + ' of asset ' + currentAsset.assetId + ' from input #' + currentInputIndex + ' asset #' + currentAssetIndex + ' to output #' + payment.output);
        assets[payment.output][assets[payment.output].length - 1].amount += currentAmount;
      } else {
        assets[payment.output].push({
          assetId: currentAsset.assetId,
          amount: currentAmount,
          issueTxid: currentAsset.issueTxid,
          divisibility: currentAsset.divisibility,
          lockStatus: currentAsset.lockStatus,
          aggregationPolicy: currentAsset.aggregationPolicy
        });
      }
    }
    currentAsset.amount -= currentAmount;
    payment.amount -= currentAmount;
    if (currentAsset.amount === 0) {
      currentAssetIndex++;
      while (currentInputIndex < _inputs.length && currentAssetIndex > _inputs[currentInputIndex].assets.length - 1) {
        currentAssetIndex = 0;
        currentInputIndex++;
      }
    }

    debug('input #' + currentInputIndex + ', asset # ' + currentAssetIndex);

    lastPaymentIndex = i;
    if (payment.amount) {
      debug('payment not completed, stay on current payment');
      i--;
    }
  }

  // finished paying explicit payments, transfer all assets with remaining amount from inputs to last output. aggregate if possible.
  transferToLastOutput(assets, _inputs, transaction_data.vout.length - 1);

  return true
}

// transfer all positive amount assets from inputs to last output. aggregate if possible.
function transferToLastOutput (assets, inputs, lastOutputIndex) {
  let assetsToTransfer = [];
  inputs.forEach((input) => {
    assetsToTransfer = _.concat(assetsToTransfer, input.assets);
  });
  const assetsIndexes = {}
  const lastOutputAssets = []
  assetsToTransfer.forEach((asset, index) => {
    if (asset.aggregationPolicy === 'aggregatable' && (typeof assetsIndexes[asset.assetId] !== 'undefined')) {
      lastOutputAssets[assetsIndexes[asset.assetId]].amount += asset.amount;
    } else if (asset.amount > 0) {
      if (typeof assetsIndexes[asset.assetId] === 'undefined') {
        assetsIndexes[asset.assetId] = lastOutputAssets.length;
      }
      lastOutputAssets.push({
        assetId: asset.assetId,
        amount: asset.amount,
        issueTxid: asset.issueTxid,
        divisibility: asset.divisibility,
        lockStatus: asset.lockStatus,
        aggregationPolicy: asset.aggregationPolicy
      });
    }
  })

  assets[lastOutputIndex] = _.concat((assets[lastOutputIndex] || []), lastOutputAssets);
}

function isPaymentSimple (payment) {
  return (!payment.range && !payment.percent);
}
