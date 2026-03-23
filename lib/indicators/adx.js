// ================================================
// NEXUS TRADING TERMINAL - ADX INDICATOR
// With +DI/-DI calculations
// ================================================

import { calculateRMA } from './supertrend.js';

/**
 * Calculate ADX (Average Directional Index)
 * @param {Array} ohlcv - OHLCV data array
 * @param {number} length - ADX period
 * @returns {object}
 */
function calculateADX(ohlcv, length = 14) {
    if (!ohlcv || ohlcv.length < length + 1) {
        return {
            adx: [],
            plusDI: [],
            minusDI: [],
            dx: []
        };
    }

    const trValues = [];
    const plusDM = [];
    const minusDM = [];

    // Calculate TR, +DM, -DM
    for (let i = 1; i < ohlcv.length; i++) {
        const current = ohlcv[i];
        const previous = ohlcv[i - 1];

        // True Range
        const tr = Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        );
        trValues.push(tr);

        // Directional Movement
        const upMove = current.high - previous.high;
        const downMove = previous.low - current.low;

        if (upMove > downMove && upMove > 0) {
            plusDM.push(upMove);
        } else {
            plusDM.push(0);
        }

        if (downMove > upMove && downMove > 0) {
            minusDM.push(downMove);
        } else {
            minusDM.push(0);
        }
    }

    // Smooth TR, +DM, -DM using Wilder's smoothing (RMA)
    const smoothedTR = calculateRMA(trValues, length);
    const smoothedPlusDM = calculateRMA(plusDM, length);
    const smoothedMinusDM = calculateRMA(minusDM, length);

    // Calculate +DI, -DI
    const plusDI = [];
    const minusDI = [];
    const dx = [];

    for (let i = 0; i < smoothedTR.length; i++) {
        if (smoothedTR[i] === null || smoothedTR[i] === 0) {
            plusDI.push(null);
            minusDI.push(null);
            dx.push(null);
        } else {
            const pdi = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
            const mdi = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
            plusDI.push(pdi);
            minusDI.push(mdi);

            // DX
            const diSum = pdi + mdi;
            if (diSum === 0) {
                dx.push(0);
            } else {
                dx.push((Math.abs(pdi - mdi) / diSum) * 100);
            }
        }
    }

    // Calculate ADX (smoothed DX)
    const adx = calculateRMA(dx.filter(v => v !== null), length);

    // Pad ADX array to match length
    const paddedADX = [];
    let adxIdx = 0;
    for (let i = 0; i < dx.length; i++) {
        if (dx[i] === null) {
            paddedADX.push(null);
        } else if (adxIdx < adx.length) {
            paddedADX.push(adx[adxIdx]);
            adxIdx++;
        } else {
            paddedADX.push(null);
        }
    }

    // Prepend null for the first value (no previous candle)
    return {
        adx: [null, ...paddedADX],
        plusDI: [null, ...plusDI],
        minusDI: [null, ...minusDI],
        dx: [null, ...dx]
    };
}

/**
 * Detect if ADX is rising
 * @param {Array<number>} adx - ADX values
 * @param {number} lookback - Lookback period
 * @returns {boolean}
 */
function isADXRising(adx, lookback = 3) {
    const validValues = adx.filter(v => v !== null);
    if (validValues.length < lookback) return false;

    const recent = validValues.slice(-lookback);

    // Check if generally rising
    let risingCount = 0;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] > recent[i - 1]) risingCount++;
    }

    return risingCount >= Math.floor(lookback / 2);
}

/**
 * Detect if ADX is falling from a high level
 * @param {Array<number>} adx - ADX values
 * @param {number} threshold - Threshold level
 * @returns {boolean}
 */
function isADXTurningDown(adx, threshold = 30) {
    const validValues = adx.filter(v => v !== null);
    if (validValues.length < 3) return false;

    const current = validValues[validValues.length - 1];
    const previous = validValues[validValues.length - 2];
    const beforePrev = validValues[validValues.length - 3];

    // Was above threshold and now falling
    return previous > threshold && current < previous && beforePrev < previous;
}

/**
 * Get current ADX signal
 * @param {Array} ohlcv - OHLCV data
 * @param {number} length - ADX period
 * @param {number} secondarySetpoint - Setpoint for secondary signal (default 20)
 * @param {number} protectionThreshold - Threshold for position protection (default 30)
 * @returns {object}
 */
function getADXSignal(ohlcv, length = 14, secondarySetpoint = 20, protectionThreshold = 30) {
    const result = calculateADX(ohlcv, length);

    if (result.adx.length === 0) {
        return {
            adx: null,
            plusDI: null,
            minusDI: null,
            secondaryLong: false,
            secondaryShort: false,
            protectionClose: false,
            isRising: false,
            isFalling: false
        };
    }

    const len = result.adx.length;
    const currentADX = result.adx[len - 1];
    const currentPlusDI = result.plusDI[len - 1];
    const currentMinusDI = result.minusDI[len - 1];

    if (currentADX === null) {
        return {
            adx: null,
            plusDI: currentPlusDI,
            minusDI: currentMinusDI,
            secondaryLong: false,
            secondaryShort: false,
            protectionClose: false,
            isRising: false,
            isFalling: false
        };
    }

    const isRising = isADXRising(result.adx);
    const isFalling = isADXTurningDown(result.adx, protectionThreshold);

    // Secondary signals: ADX > setpoint and rising, with DI confirmation
    const strongTrend = currentADX > secondarySetpoint && isRising;
    const secondaryLong = strongTrend && currentPlusDI > currentMinusDI;
    const secondaryShort = strongTrend && currentMinusDI > currentPlusDI;

    // Position protection: ADX turning down from high
    const protectionClose = isFalling;

    return {
        adx: currentADX,
        plusDI: currentPlusDI,
        minusDI: currentMinusDI,
        dx: result.dx[len - 1],
        secondaryLong,
        secondaryShort,
        protectionClose,
        isRising,
        isFalling,
        strongTrend
    };
}

export { calculateADX, isADXRising, isADXTurningDown, getADXSignal };
