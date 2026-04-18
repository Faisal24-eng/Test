// ================================================
// NEXUS TRADING TERMINAL - ORDER BOOK INDICATOR
// Liquidity analysis
// ================================================

/**
 * Analyze order book for liquidity imbalance and walls
 * @param {object} orderbook - Order book data with bids and asks
 * @param {number} depth - Depth levels to analyze
 * @param {number} imbalanceThreshold - Imbalance threshold percentage
 * @returns {object}
 */
function analyzeOrderBook(orderbook, depth = 50, imbalanceThreshold = 60) {
    if (!orderbook || !orderbook.bids || !orderbook.asks) {
        return {
            bidLiquidity: 0,
            askLiquidity: 0,
            imbalancePercent: 0,
            bidDominant: false,
            askDominant: false,
            bidWall: null,
            askWall: null,
            absorption: null
        };
    }

    // Limit to specified depth
    const bids = orderbook.bids.slice(0, depth);
    const asks = orderbook.asks.slice(0, depth);

    // Calculate total liquidity
    const bidLiquidity = bids.reduce((sum, b) => sum + (b.price * b.quantity), 0);
    const askLiquidity = asks.reduce((sum, a) => sum + (a.price * a.quantity), 0);
    const totalLiquidity = bidLiquidity + askLiquidity;

    // Imbalance percentage
    let bidPercent = 0;
    let askPercent = 0;
    if (totalLiquidity > 0) {
        bidPercent = (bidLiquidity / totalLiquidity) * 100;
        askPercent = (askLiquidity / totalLiquidity) * 100;
    }

    const imbalancePercent = Math.abs(bidPercent - askPercent);
    const bidDominant = bidPercent >= imbalanceThreshold;
    const askDominant = askPercent >= imbalanceThreshold;

    // Detect walls (large orders that stand out)
    const bidWall = detectWall(bids);
    const askWall = detectWall(asks);

    return {
        bidLiquidity,
        askLiquidity,
        totalLiquidity,
        bidPercent,
        askPercent,
        imbalancePercent,
        bidDominant,
        askDominant,
        bidWall,
        askWall
    };
}

/**
 * Detect large walls in order book
 * @param {Array} orders - Bids or asks array
 * @returns {object|null} - Wall info or null
 */
function detectWall(orders) {
    if (!orders || orders.length < 5) return null;

    // Calculate average order size
    const totalQty = orders.reduce((sum, o) => sum + o.quantity, 0);
    const avgQty = totalQty / orders.length;

    // Find orders that are significantly larger than average (3x+)
    const wallThreshold = avgQty * 3;

    for (let i = 0; i < Math.min(orders.length, 20); i++) {
        if (orders[i].quantity >= wallThreshold) {
            return {
                price: orders[i].price,
                quantity: orders[i].quantity,
                position: i,
                multiplier: orders[i].quantity / avgQty
            };
        }
    }

    return null;
}

/**
 * Compare two order book snapshots for absorption/wall changes
 * @param {object} previous - Previous order book analysis
 * @param {object} current - Current order book analysis
 * @param {number} currentPrice - Current price
 * @returns {object}
 */
function detectAbsorption(previous, current, currentPrice) {
    if (!previous || !current) {
        return {
            bidAbsorption: false,
            askAbsorption: false,
            bidWallPulled: false,
            askWallPulled: false
        };
    }

    // Bid absorption: Had a bid wall, price stalled, orders filled
    const bidAbsorption = previous.bidWall !== null &&
        current.bidWall === null &&
        current.bidLiquidity < previous.bidLiquidity * 0.7;

    // Ask absorption: Had an ask wall, price stalled, orders filled
    const askAbsorption = previous.askWall !== null &&
        current.askWall === null &&
        current.askLiquidity < previous.askLiquidity * 0.7;

    // Wall pulled (disappeared without being filled)
    const bidWallPulled = previous.bidWall !== null &&
        current.bidWall === null &&
        current.bidLiquidity >= previous.bidLiquidity * 0.9;

    const askWallPulled = previous.askWall !== null &&
        current.askWall === null &&
        current.askLiquidity >= previous.askLiquidity * 0.9;

    return {
        bidAbsorption,
        askAbsorption,
        bidWallPulled,
        askWallPulled
    };
}

/**
 * Get current Order Book signal
 * @param {object} orderbook - Order book data
 * @param {object} previousAnalysis - Previous analysis for comparison
 * @param {number} currentPrice - Current price
 * @param {number} depth - Depth levels
 * @param {number} imbalanceThreshold - Imbalance threshold
 * @returns {object}
 */
function getOrderBookSignal(orderbook, previousAnalysis, currentPrice, depth = 50, imbalanceThreshold = 60) {
    const analysis = analyzeOrderBook(orderbook, depth, imbalanceThreshold);
    const absorption = detectAbsorption(previousAnalysis, analysis, currentPrice);

    // Primary signals: absorption entries
    const primaryLong = absorption.bidAbsorption; // Bid wall absorbed, bullish
    const primaryShort = absorption.askAbsorption; // Ask wall absorbed, bearish

    // Secondary signals: liquidity imbalance
    const secondaryLong = analysis.bidDominant; // Bid liquidity >= threshold
    const secondaryShort = analysis.askDominant; // Ask liquidity >= threshold

    // Position protection
    // Close long if bid wall pulled or strong ask wall appears
    const protectionCloseLong = absorption.bidWallPulled ||
        (analysis.askWall !== null && analysis.askWall.multiplier > 4);

    // Close short if ask wall pulled or strong bid wall appears
    const protectionCloseShort = absorption.askWallPulled ||
        (analysis.bidWall !== null && analysis.bidWall.multiplier > 4);

    return {
        ...analysis,
        ...absorption,
        primaryLong,
        primaryShort,
        secondaryLong,
        secondaryShort,
        protectionCloseLong,
        protectionCloseShort
    };
}

export { analyzeOrderBook, detectWall, detectAbsorption, getOrderBookSignal };
