// ================================================
// NEXUS TRADING TERMINAL - VWAP INDICATOR
// With standard deviation bands and session resets
// ================================================

/**
 * Check if a new session/period has started
 * @param {number} currentTimestamp - Current candle timestamp
 * @param {number} previousTimestamp - Previous candle timestamp
 * @param {string} anchor - Anchor period ('session', 'day', 'week')
 * @returns {boolean} - True if new period started
 */
function isNewPeriod(currentTimestamp, previousTimestamp, anchor) {
    if (!previousTimestamp) return true; // First candle always starts new period

    const current = new Date(currentTimestamp);
    const previous = new Date(previousTimestamp);

    switch (anchor) {
        case 'day':
        case 'session':
            // Reset at UTC 00:00 (daily reset - standard for crypto)
            const currentDay = Math.floor(currentTimestamp / (24 * 60 * 60 * 1000));
            const previousDay = Math.floor(previousTimestamp / (24 * 60 * 60 * 1000));
            return currentDay !== previousDay;

        case 'week':
            // Reset at start of week (Monday 00:00 UTC)
            const currentWeek = getWeekNumber(current);
            const previousWeek = getWeekNumber(previous);
            return currentWeek.year !== previousWeek.year || currentWeek.week !== previousWeek.week;

        default:
            // No reset (original behavior)
            return false;
    }
}

/**
 * Get ISO week number for a date
 * @param {Date} date
 * @returns {object} - { year, week }
 */
function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
}

/**
 * Calculate VWAP with standard deviation bands
 * @param {Array} ohlcv - OHLCV data array
 * @param {string} source - Price source ('typical', 'close', 'hlc3')
 * @param {Array<number>} bands - Standard deviation multipliers
 * @param {string} anchor - Anchor period ('session', 'day', 'week', 'none')
 * @returns {object}
 */
function calculateVWAP(ohlcv, source = 'typical', bands = [1, 2], anchor = 'day') {
    if (!ohlcv || ohlcv.length === 0) {
        return {
            vwap: [],
            upperBand1: [],
            lowerBand1: [],
            upperBand2: [],
            lowerBand2: []
        };
    }

    const vwapValues = [];
    const upperBand1 = [];
    const lowerBand1 = [];
    const upperBand2 = [];
    const lowerBand2 = [];

    let cumulativeTPV = 0;  // Cumulative (typical price * volume)
    let cumulativeVolume = 0;
    let cumulativeTPV2 = 0; // For standard deviation
    let previousTimestamp = null;

    for (let i = 0; i < ohlcv.length; i++) {
        const candle = ohlcv[i];

        // Check for new session/day/week - reset cumulative values
        if (anchor !== 'none' && isNewPeriod(candle.timestamp, previousTimestamp, anchor)) {
            cumulativeTPV = 0;
            cumulativeVolume = 0;
            cumulativeTPV2 = 0;
        }
        previousTimestamp = candle.timestamp;

        // Get typical price based on source
        let typicalPrice;
        switch (source) {
            case 'close':
                typicalPrice = candle.close;
                break;
            case 'hl2':
                typicalPrice = (candle.high + candle.low) / 2;
                break;
            case 'hlc3':
            case 'typical':
            default:
                typicalPrice = (candle.high + candle.low + candle.close) / 3;
                break;
        }

        const volume = candle.volume;

        // Cumulative calculations
        cumulativeTPV += typicalPrice * volume;
        cumulativeVolume += volume;
        cumulativeTPV2 += typicalPrice * typicalPrice * volume;

        if (cumulativeVolume === 0) {
            vwapValues.push(null);
            upperBand1.push(null);
            lowerBand1.push(null);
            upperBand2.push(null);
            lowerBand2.push(null);
            continue;
        }

        // VWAP
        const vwap = cumulativeTPV / cumulativeVolume;
        vwapValues.push(vwap);

        // Standard deviation
        const variance = (cumulativeTPV2 / cumulativeVolume) - (vwap * vwap);
        const stdDev = Math.sqrt(Math.max(0, variance));

        // Bands
        upperBand1.push(vwap + stdDev * (bands[0] || 1));
        lowerBand1.push(vwap - stdDev * (bands[0] || 1));
        upperBand2.push(vwap + stdDev * (bands[1] || 2));
        lowerBand2.push(vwap - stdDev * (bands[1] || 2));
    }

    return {
        vwap: vwapValues,
        upperBand1,
        lowerBand1,
        upperBand2,
        lowerBand2
    };
}


/**
 * Get current VWAP signal
 * @param {Array} ohlcv - OHLCV data
 * @param {string} source - Price source
 * @param {Array<number>} bands - SD multipliers
 * @returns {object}
 */
function getVWAPSignal(ohlcv, source = 'typical', bands = [1, 2]) {
    const result = calculateVWAP(ohlcv, source, bands);

    if (result.vwap.length === 0 || !ohlcv || ohlcv.length === 0) {
        return {
            vwap: null,
            currentPrice: null,
            priceAboveVWAP: null,
            primaryLong: false,
            primaryShort: false,
            secondaryLong: false,
            secondaryShort: false,
            protectionCloseLong: false,
            protectionCloseShort: false
        };
    }

    const len = result.vwap.length;
    const currentVWAP = result.vwap[len - 1];
    const currentPrice = ohlcv[len - 1].close;
    const prevPrice = len > 1 ? ohlcv[len - 2].close : null;

    if (currentVWAP === null) {
        return {
            vwap: null,
            currentPrice,
            priceAboveVWAP: null,
            primaryLong: false,
            primaryShort: false,
            secondaryLong: false,
            secondaryShort: false,
            protectionCloseLong: false,
            protectionCloseShort: false
        };
    }

    const upperBand1 = result.upperBand1[len - 1];
    const lowerBand1 = result.lowerBand1[len - 1];
    const upperBand2 = result.upperBand2[len - 1];
    const lowerBand2 = result.lowerBand2[len - 1];

    const priceAboveVWAP = currentPrice > currentVWAP;

    // Primary signals: Pullback entries
    // Long if price pulls back to VWAP or -1 SD
    const pullbackToVWAPOrLower = currentPrice <= currentVWAP + (upperBand1 - currentVWAP) * 0.1 ||
        currentPrice <= lowerBand1;
    const priceWasAbove = prevPrice !== null && prevPrice > currentVWAP;
    const primaryLong = pullbackToVWAPOrLower && priceWasAbove;

    // Short if price pulls back to VWAP or +1 SD
    const pullbackToVWAPOrUpper = currentPrice >= currentVWAP - (currentVWAP - lowerBand1) * 0.1 ||
        currentPrice >= upperBand1;
    const priceWasBelow = prevPrice !== null && prevPrice < currentVWAP;
    const primaryShort = pullbackToVWAPOrUpper && priceWasBelow;

    // Secondary signals
    const secondaryLong = priceAboveVWAP;
    const secondaryShort = !priceAboveVWAP;

    // Position protection
    // Close long if +2 SD or lost VWAP
    const protectionCloseLong = currentPrice >= upperBand2 ||
        (priceWasAbove && currentPrice < currentVWAP);

    // Close short if -2 SD or reclaimed VWAP
    const protectionCloseShort = currentPrice <= lowerBand2 ||
        (priceWasBelow && currentPrice > currentVWAP);

    return {
        vwap: currentVWAP,
        currentPrice,
        upperBand1,
        lowerBand1,
        upperBand2,
        lowerBand2,
        priceAboveVWAP,
        primaryLong,
        primaryShort,
        secondaryLong,
        secondaryShort,
        protectionCloseLong,
        protectionCloseShort
    };
}

export { calculateVWAP, getVWAPSignal };
