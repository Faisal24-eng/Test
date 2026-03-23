// ================================================
// NEXUS TRADING TERMINAL - SUPERTREND INDICATOR
// Uses RMA/SMMA (Running Moving Average / Smoothed Moving Average)
// ================================================

/**
 * Calculate RMA (Running Moving Average) - same as SMMA
 * @param {Array<number>} values - Array of values
 * @param {number} period - Period for RMA
 * @returns {Array<number>} - RMA values
 */
function calculateRMA(values, period) {
    const rma = [];
    let sum = 0;

    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) {
            sum += values[i];
            rma.push(null);
        } else if (i === period - 1) {
            sum += values[i];
            rma.push(sum / period);
        } else {
            const prevRMA = rma[i - 1];
            const currentRMA = (prevRMA * (period - 1) + values[i]) / period;
            rma.push(currentRMA);
        }
    }

    return rma;
}

/**
 * Calculate True Range
 * @param {object} current - Current candle
 * @param {object} previous - Previous candle
 * @returns {number}
 */
function calculateTR(current, previous) {
    if (!previous) return current.high - current.low;

    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - previous.close);
    const tr3 = Math.abs(current.low - previous.close);

    return Math.max(tr1, tr2, tr3);
}

/**
 * Get source price from candle
 * @param {object} candle - OHLCV candle
 * @param {string} source - Source type ('close', 'hl2', 'hlc3', 'ohlc4')
 * @returns {number}
 */
function getSourcePrice(candle, source = 'close') {
    switch (source) {
        case 'open':
            return candle.open;
        case 'high':
            return candle.high;
        case 'low':
            return candle.low;
        case 'close':
            return candle.close;
        case 'hl2':
            return (candle.high + candle.low) / 2;
        case 'hlc3':
            return (candle.high + candle.low + candle.close) / 3;
        case 'ohlc4':
            return (candle.open + candle.high + candle.low + candle.close) / 4;
        default:
            return candle.close;
    }
}

/**
 * Calculate Supertrend indicator using RMA for ATR
 * @param {Array} ohlcv - OHLCV data array
 * @param {number} atrPeriod - ATR period (default 7)
 * @param {number} multiplier - ATR multiplier (default 2)
 * @param {string} source - Price source ('close', 'hl2', 'hlc3', 'ohlc4')
 * @returns {object} - Supertrend data with trend, upper/lower bands
 */
function calculateSupertrend(ohlcv, atrPeriod = 7, multiplier = 2, source = 'close') {
    if (!ohlcv || ohlcv.length < atrPeriod + 1) {
        return {
            trend: [],
            upperBand: [],
            lowerBand: [],
            supertrend: [],
            direction: []
        };
    }

    // Calculate True Range
    const trValues = [];
    for (let i = 0; i < ohlcv.length; i++) {
        const tr = calculateTR(ohlcv[i], i > 0 ? ohlcv[i - 1] : null);
        trValues.push(tr);
    }

    // Calculate ATR using RMA
    const atr = calculateRMA(trValues, atrPeriod);

    // Calculate bands and Supertrend
    const upperBand = [];
    const lowerBand = [];
    const supertrend = [];
    const direction = []; // +1 for uptrend, -1 for downtrend

    for (let i = 0; i < ohlcv.length; i++) {
        if (atr[i] === null) {
            upperBand.push(null);
            lowerBand.push(null);
            supertrend.push(null);
            direction.push(0);
            continue;
        }

        const src = getSourcePrice(ohlcv[i], source);
        const hl2 = (ohlcv[i].high + ohlcv[i].low) / 2;

        // Basic bands
        let basicUpperBand = hl2 + (multiplier * atr[i]);
        let basicLowerBand = hl2 - (multiplier * atr[i]);

        // Final bands (with trailing logic)
        let finalUpperBand = basicUpperBand;
        let finalLowerBand = basicLowerBand;

        if (i > 0 && upperBand[i - 1] !== null) {
            const prevClose = ohlcv[i - 1].close;

            // Upper band trailing
            if (basicUpperBand < upperBand[i - 1] || prevClose > upperBand[i - 1]) {
                finalUpperBand = basicUpperBand;
            } else {
                finalUpperBand = upperBand[i - 1];
            }

            // Lower band trailing
            if (basicLowerBand > lowerBand[i - 1] || prevClose < lowerBand[i - 1]) {
                finalLowerBand = basicLowerBand;
            } else {
                finalLowerBand = lowerBand[i - 1];
            }
        }

        upperBand.push(finalUpperBand);
        lowerBand.push(finalLowerBand);

        // Determine Supertrend direction
        let currentDirection;
        let stValue;

        if (i === 0 || supertrend[i - 1] === null) {
            // Initial direction based on close vs bands
            currentDirection = ohlcv[i].close > finalUpperBand ? 1 : -1;
        } else {
            const prevDirection = direction[i - 1];
            const prevST = supertrend[i - 1];

            if (prevDirection === 1) {
                // Was in uptrend
                if (ohlcv[i].close < finalLowerBand) {
                    currentDirection = -1; // Switch to downtrend
                } else {
                    currentDirection = 1; // Stay in uptrend
                }
            } else {
                // Was in downtrend
                if (ohlcv[i].close > finalUpperBand) {
                    currentDirection = 1; // Switch to uptrend
                } else {
                    currentDirection = -1; // Stay in downtrend
                }
            }
        }

        // Supertrend value is the active band
        stValue = currentDirection === 1 ? finalLowerBand : finalUpperBand;

        direction.push(currentDirection);
        supertrend.push(stValue);
    }

    return {
        trend: direction,
        direction,  // Also expose as 'direction' for getSupertrendSignal
        upperBand,
        lowerBand,
        supertrend,
        atr
    };
}

/**
 * Get current Supertrend signal
 * @param {Array} ohlcv - OHLCV data
 * @param {number} atrPeriod - ATR period
 * @param {number} multiplier - ATR multiplier
 * @param {string} source - Price source
 * @returns {object} - Current signal data
 */
function getSupertrendSignal(ohlcv, atrPeriod = 7, multiplier = 2, source = 'close') {
    const result = calculateSupertrend(ohlcv, atrPeriod, multiplier, source);

    if (result.direction.length < 2) {
        return {
            trend: 0,
            previousTrend: 0,
            trendChanged: false,
            changeType: null,
            supertrendValue: null,
            currentPrice: null
        };
    }

    const len = result.direction.length;
    const currentTrend = result.direction[len - 1];
    const previousTrend = result.direction[len - 2];
    const trendChanged = currentTrend !== previousTrend && previousTrend !== 0;

    let changeType = null;
    if (trendChanged) {
        changeType = currentTrend === 1 ? 'bullish' : 'bearish';
    }

    return {
        trend: currentTrend,
        previousTrend,
        trendChanged,
        changeType,
        supertrendValue: result.supertrend[len - 1],
        upperBand: result.upperBand[len - 1],
        lowerBand: result.lowerBand[len - 1],
        atr: result.atr[len - 1],
        currentPrice: ohlcv[len - 1].close
    };
}

// Export for module usage
export { calculateSupertrend, getSupertrendSignal, calculateRMA, getSourcePrice };
