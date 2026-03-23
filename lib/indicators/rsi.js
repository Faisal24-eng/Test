// ================================================
// NEXUS TRADING TERMINAL - RSI INDICATOR
// With divergence detection
// ================================================

import { getSourcePrice, calculateRMA } from './supertrend.js';

/**
 * Calculate RSI (Relative Strength Index)
 * @param {Array<number>} prices - Array of prices
 * @param {number} length - RSI period
 * @returns {Array<number>}
 */
function calculateRSI(prices, length = 14) {
    if (!prices || prices.length < length + 1) return [];

    const rsi = [];
    const gains = [];
    const losses = [];

    // Calculate price changes
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }

    // Calculate RMA of gains and losses
    const avgGain = calculateRMA(gains, length);
    const avgLoss = calculateRMA(losses, length);

    // Calculate RSI
    rsi.push(null); // First value has no change

    for (let i = 0; i < avgGain.length; i++) {
        if (avgGain[i] === null || avgLoss[i] === null) {
            rsi.push(null);
        } else if (avgLoss[i] === 0) {
            rsi.push(100);
        } else {
            const rs = avgGain[i] / avgLoss[i];
            rsi.push(100 - (100 / (1 + rs)));
        }
    }

    return rsi;
}

/**
 * Calculate RSI from OHLCV data
 * @param {Array} ohlcv - OHLCV data array
 * @param {number} length - RSI period
 * @param {string} source - Price source
 * @returns {object}
 */
function calculateRSIFromOHLCV(ohlcv, length = 14, source = 'close') {
    if (!ohlcv || ohlcv.length < length + 1) {
        return { values: [] };
    }

    const prices = ohlcv.map(candle => getSourcePrice(candle, source));
    return { values: calculateRSI(prices, length) };
}

/**
 * Detect divergence between price and RSI
 * @param {Array} ohlcv - OHLCV data
 * @param {Array<number>} rsiValues - RSI values
 * @param {number} lookback - Lookback period for divergence detection
 * @returns {object}
 */
function detectDivergence(ohlcv, rsiValues, lookback = 14) {
    if (!ohlcv || !rsiValues || ohlcv.length < lookback + 5) {
        return { bullish: false, bearish: false };
    }

    const len = ohlcv.length;
    const start = len - lookback;

    // Find local lows and highs in both price and RSI
    const priceLows = [];
    const priceHighs = [];
    const rsiLows = [];
    const rsiHighs = [];

    for (let i = start + 1; i < len - 1; i++) {
        const price = ohlcv[i].close;
        const prevPrice = ohlcv[i - 1].close;
        const nextPrice = ohlcv[i + 1].close;

        const rsi = rsiValues[i];
        const prevRSI = rsiValues[i - 1];
        const nextRSI = rsiValues[i + 1];

        if (rsi === null || prevRSI === null || nextRSI === null) continue;

        // Local low
        if (price < prevPrice && price < nextPrice) {
            priceLows.push({ idx: i, value: price });
        }
        if (rsi < prevRSI && rsi < nextRSI) {
            rsiLows.push({ idx: i, value: rsi });
        }

        // Local high
        if (price > prevPrice && price > nextPrice) {
            priceHighs.push({ idx: i, value: price });
        }
        if (rsi > prevRSI && rsi > nextRSI) {
            rsiHighs.push({ idx: i, value: rsi });
        }
    }

    // Bullish divergence: price makes lower low, RSI makes higher low
    let bullishDivergence = false;
    if (priceLows.length >= 2 && rsiLows.length >= 2) {
        const lastPriceLow = priceLows[priceLows.length - 1];
        const prevPriceLow = priceLows[priceLows.length - 2];
        const lastRSILow = rsiLows[rsiLows.length - 1];
        const prevRSILow = rsiLows[rsiLows.length - 2];

        if (lastPriceLow.value < prevPriceLow.value &&
            lastRSILow.value > prevRSILow.value) {
            bullishDivergence = true;
        }
    }

    // Bearish divergence: price makes higher high, RSI makes lower high
    let bearishDivergence = false;
    if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
        const lastPriceHigh = priceHighs[priceHighs.length - 1];
        const prevPriceHigh = priceHighs[priceHighs.length - 2];
        const lastRSIHigh = rsiHighs[rsiHighs.length - 1];
        const prevRSIHigh = rsiHighs[rsiHighs.length - 2];

        if (lastPriceHigh.value > prevPriceHigh.value &&
            lastRSIHigh.value < prevRSIHigh.value) {
            bearishDivergence = true;
        }
    }

    return {
        bullish: bullishDivergence,
        bearish: bearishDivergence
    };
}

/**
 * Get current RSI signal
 * @param {Array} ohlcv - OHLCV data
 * @param {number} length - RSI period
 * @param {number} overbought - Overbought level
 * @param {number} oversold - Oversold level
 * @param {string} source - Price source
 * @returns {object}
 */
function getRSISignal(ohlcv, length = 14, overbought = 70, oversold = 30, source = 'close') {
    const result = calculateRSIFromOHLCV(ohlcv, length, source);

    if (result.values.length === 0) {
        return {
            rsi: null,
            isOverbought: false,
            isOversold: false,
            primaryLong: false,
            primaryShort: false,
            secondaryLong: false,
            secondaryShort: false,
            bullishDivergence: false,
            bearishDivergence: false
        };
    }

    const len = result.values.length;
    const currentRSI = result.values[len - 1];

    if (currentRSI === null) {
        return {
            rsi: null,
            isOverbought: false,
            isOversold: false,
            primaryLong: false,
            primaryShort: false,
            secondaryLong: false,
            secondaryShort: false,
            bullishDivergence: false,
            bearishDivergence: false
        };
    }

    // Detect divergence
    const divergence = detectDivergence(ohlcv, result.values);

    // Overbought/Oversold
    const isOverbought = currentRSI >= overbought;
    const isOversold = currentRSI <= oversold;

    // Previous RSI for pullback detection
    const prevRSI = len > 1 ? result.values[len - 2] : null;

    // Primary signals: pullback entries
    // Long if RSI pulls back to 40-50 zone
    const primaryLong = currentRSI >= 40 && currentRSI <= 50 &&
        prevRSI !== null && prevRSI > 50;

    // Short if RSI pulls back to 50-60 zone
    const primaryShort = currentRSI >= 50 && currentRSI <= 60 &&
        prevRSI !== null && prevRSI < 50;

    // Secondary signals: hold above/below levels
    const secondaryLong = currentRSI > 40;  // RSI holds above 40
    const secondaryShort = currentRSI < 60; // RSI holds below 60

    // Position protection triggers
    const protectionCloseLong = divergence.bearish || currentRSI < 40;
    const protectionCloseShort = divergence.bullish || currentRSI > 60;

    return {
        rsi: currentRSI,
        prevRSI,
        isOverbought,
        isOversold,
        primaryLong,
        primaryShort,
        secondaryLong,
        secondaryShort,
        bullishDivergence: divergence.bullish,
        bearishDivergence: divergence.bearish,
        protectionCloseLong,
        protectionCloseShort
    };
}

export { calculateRSI, calculateRSIFromOHLCV, detectDivergence, getRSISignal };
