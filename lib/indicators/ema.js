// ================================================
// NEXUS TRADING TERMINAL - EMA INDICATOR
// With slope detection
// ================================================

import { getSourcePrice } from './supertrend.js';

/**
 * Calculate Exponential Moving Average
 * @param {Array<number>} values - Array of values
 * @param {number} length - EMA period
 * @returns {Array<number>}
 */
function calculateEMA(values, length) {
    if (!values || values.length === 0) return [];

    const ema = [];
    const multiplier = 2 / (length + 1);

    // Start with SMA for first value
    let sum = 0;
    for (let i = 0; i < Math.min(length, values.length); i++) {
        sum += values[i];
    }

    for (let i = 0; i < values.length; i++) {
        if (i < length - 1) {
            ema.push(null);
        } else if (i === length - 1) {
            ema.push(sum / length);
        } else {
            const currentEMA = (values[i] - ema[i - 1]) * multiplier + ema[i - 1];
            ema.push(currentEMA);
        }
    }

    return ema;
}

/**
 * Calculate EMA from OHLCV data
 * @param {Array} ohlcv - OHLCV data array
 * @param {number} length - EMA period (default 200)
 * @param {string} source - Price source
 * @returns {object} - EMA data with values and slope
 */
function calculate200EMA(ohlcv, length = 200, source = 'close') {
    if (!ohlcv || ohlcv.length < length) {
        return {
            values: [],
            slope: [],
            slopeDirection: []
        };
    }

    // Extract source prices
    const prices = ohlcv.map(candle => getSourcePrice(candle, source));

    // Calculate EMA
    const emaValues = calculateEMA(prices, length);

    // Calculate slope (difference between current and previous EMA)
    const slope = [];
    const slopeDirection = [];

    for (let i = 0; i < emaValues.length; i++) {
        if (i === 0 || emaValues[i] === null || emaValues[i - 1] === null) {
            slope.push(null);
            slopeDirection.push(0);
        } else {
            const slopeValue = emaValues[i] - emaValues[i - 1];
            slope.push(slopeValue);
            slopeDirection.push(slopeValue > 0 ? 1 : slopeValue < 0 ? -1 : 0);
        }
    }

    return {
        values: emaValues,
        slope,
        slopeDirection
    };
}

/**
 * Get current EMA signal
 * @param {Array} ohlcv - OHLCV data
 * @param {number} length - EMA period
 * @param {string} source - Price source
 * @returns {object} - Current EMA signal data
 */
function getEMASignal(ohlcv, length = 200, source = 'close') {
    const result = calculate200EMA(ohlcv, length, source);

    if (result.values.length === 0 || !ohlcv || ohlcv.length === 0) {
        return {
            emaValue: null,
            currentPrice: null,
            priceAboveEMA: null,
            slope: null,
            slopeUp: null,
            bullish: null, // Price above + slope up
            bearish: null  // Price below + slope down
        };
    }

    const len = result.values.length;
    const emaValue = result.values[len - 1];
    const currentPrice = ohlcv[len - 1].close;
    const slope = result.slope[len - 1];

    if (emaValue === null) {
        return {
            emaValue: null,
            currentPrice,
            priceAboveEMA: null,
            slope: null,
            slopeUp: null,
            bullish: null,
            bearish: null
        };
    }

    const priceAboveEMA = currentPrice > emaValue;
    const slopeUp = slope !== null && slope > 0;
    const slopeDown = slope !== null && slope < 0;

    // Strong signals: price position + slope direction aligned
    const bullish = priceAboveEMA && slopeUp;
    const bearish = !priceAboveEMA && slopeDown;

    // Price acceptance beyond EMA (for position protection)
    const priceDistance = Math.abs(currentPrice - emaValue);
    const atr = calculateSimpleATR(ohlcv, 14);
    const strongCrossBeyond = priceDistance > atr * 0.5;

    return {
        emaValue,
        currentPrice,
        priceAboveEMA,
        slope,
        slopeUp,
        slopeDown,
        bullish,
        bearish,
        priceDistance,
        strongCrossBeyond
    };
}

/**
 * Simple ATR calculation for reference
 * @param {Array} ohlcv - OHLCV data
 * @param {number} period - ATR period
 * @returns {number}
 */
function calculateSimpleATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 1) return 0;

    let sum = 0;
    for (let i = ohlcv.length - period; i < ohlcv.length; i++) {
        const tr = Math.max(
            ohlcv[i].high - ohlcv[i].low,
            Math.abs(ohlcv[i].high - ohlcv[i - 1]?.close || ohlcv[i].open),
            Math.abs(ohlcv[i].low - ohlcv[i - 1]?.close || ohlcv[i].open)
        );
        sum += tr;
    }

    return sum / period;
}

export { calculateEMA, calculate200EMA, getEMASignal };
