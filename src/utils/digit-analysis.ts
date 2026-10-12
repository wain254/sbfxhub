/**
 * Pure helpers that turn a stream of tick quotes into last-digit statistics used
 * by the AI analysis bubble and the automated market scanner.
 */

export type TDigitStats = {
    total: number;
    counts: number[];
    percentages: number[];
};

export type TAnalysisMode = 'overunder' | 'evenodd' | 'matchesdiffers';

export type TRecommendation = {
    mode: TAnalysisMode;
    /** Contract code the bot should purchase, e.g. DIGITOVER */
    contract: 'DIGITOVER' | 'DIGITUNDER' | 'DIGITEVEN' | 'DIGITODD' | 'DIGITMATCH' | 'DIGITDIFF';
    label: string;
    /** Digit barrier / prediction, if the contract needs one */
    prediction?: number;
    /** Observed win probability in % */
    probability: number;
    /** Theoretical win probability in % for a fair, uniform digit distribution */
    expected: number;
    /** probability - expected, in percentage points */
    edge: number;
};

export const getDecimalsFromPip = (pip?: number) => {
    if (!pip || pip >= 1) return 0;
    const exponent = Math.round(-Math.log10(pip));
    return Math.max(0, exponent);
};

export const getLastDigit = (quote: number | string, decimals: number) => {
    const text = Number(quote).toFixed(decimals);
    return Number(text[text.length - 1]);
};

export const getDigitStats = (digits: number[]): TDigitStats => {
    const counts = Array(10).fill(0) as number[];
    digits.forEach(d => {
        if (d >= 0 && d <= 9) counts[d] += 1;
    });
    const total = digits.length;
    const percentages = counts.map(c => (total ? (c / total) * 100 : 0));
    return { total, counts, percentages };
};

export const sumPercent = (stats: TDigitStats, predicate: (digit: number) => boolean) =>
    stats.percentages.reduce((acc, p, digit) => (predicate(digit) ? acc + p : acc), 0);

export const getOverPercent = (stats: TDigitStats, barrier: number) => sumPercent(stats, d => d > barrier);
export const getUnderPercent = (stats: TDigitStats, barrier: number) => sumPercent(stats, d => d < barrier);
export const getEvenPercent = (stats: TDigitStats) => sumPercent(stats, d => d % 2 === 0);

const makeRecommendation = (rec: Omit<TRecommendation, 'edge'>): TRecommendation => ({
    ...rec,
    edge: rec.probability - rec.expected,
});

/** Compares the user's Over and Under barriers and returns both options, best first. */
export const analyseOverUnder = (stats: TDigitStats, over: number, under: number) => {
    const over_rec = makeRecommendation({
        mode: 'overunder',
        contract: 'DIGITOVER',
        label: `Over ${over}`,
        prediction: over,
        probability: getOverPercent(stats, over),
        expected: (9 - over) * 10,
    });
    const under_rec = makeRecommendation({
        mode: 'overunder',
        contract: 'DIGITUNDER',
        label: `Under ${under}`,
        prediction: under,
        probability: getUnderPercent(stats, under),
        expected: under * 10,
    });
    // Compare by edge over the fair odds so "Over 1" doesn't always beat "Under 3"
    // simply because it covers more digits.
    const best = over_rec.edge >= under_rec.edge ? over_rec : under_rec;
    return { over: over_rec, under: under_rec, best };
};

export const analyseEvenOdd = (stats: TDigitStats) => {
    const even = getEvenPercent(stats);
    const even_rec = makeRecommendation({
        mode: 'evenodd',
        contract: 'DIGITEVEN',
        label: 'Even',
        probability: even,
        expected: 50,
    });
    const odd_rec = makeRecommendation({
        mode: 'evenodd',
        contract: 'DIGITODD',
        label: 'Odd',
        probability: stats.total ? 100 - even : 0,
        expected: 50,
    });
    return { even: even_rec, odd: odd_rec, best: even_rec.edge >= odd_rec.edge ? even_rec : odd_rec };
};

export const analyseMatchesDiffers = (stats: TDigitStats) => {
    let strongest = 0;
    let weakest = 0;
    stats.percentages.forEach((p, digit) => {
        if (p > stats.percentages[strongest]) strongest = digit;
        if (p < stats.percentages[weakest]) weakest = digit;
    });
    const matches = makeRecommendation({
        mode: 'matchesdiffers',
        contract: 'DIGITMATCH',
        label: `Matches ${strongest}`,
        prediction: strongest,
        probability: stats.percentages[strongest],
        expected: 10,
    });
    const differs = makeRecommendation({
        mode: 'matchesdiffers',
        contract: 'DIGITDIFF',
        label: `Differs ${weakest}`,
        prediction: weakest,
        probability: 100 - stats.percentages[weakest],
        expected: 90,
    });
    return { matches, differs, strongest, weakest };
};

/** Same contract chosen by the user, evaluated on another market's stats. */
export const evaluateContract = (
    stats: TDigitStats,
    contract: TRecommendation['contract'],
    prediction = 0
): TRecommendation => {
    switch (contract) {
        case 'DIGITOVER':
            return analyseOverUnder(stats, prediction, 0).over;
        case 'DIGITUNDER':
            return analyseOverUnder(stats, 9, prediction).under;
        case 'DIGITEVEN':
            return analyseEvenOdd(stats).even;
        case 'DIGITODD':
            return analyseEvenOdd(stats).odd;
        case 'DIGITMATCH':
            return analyseMatchesDiffers(stats).matches;
        case 'DIGITDIFF':
        default:
            return analyseMatchesDiffers(stats).differs;
    }
};

/** Every candidate trade for a market; used by the automated search to find the strongest edge. */
export const getAllCandidates = (stats: TDigitStats): TRecommendation[] => {
    const candidates: TRecommendation[] = [];
    for (let b = 0; b <= 8; b++) candidates.push(analyseOverUnder(stats, b, 9).over);
    for (let b = 1; b <= 9; b++) candidates.push(analyseOverUnder(stats, 0, b).under);
    const eo = analyseEvenOdd(stats);
    candidates.push(eo.even, eo.odd);
    const md = analyseMatchesDiffers(stats);
    candidates.push(md.matches, md.differs);
    return candidates;
};

export const CONTRACT_TRADE_TYPE: Record<TRecommendation['contract'], TAnalysisMode> = {
    DIGITOVER: 'overunder',
    DIGITUNDER: 'overunder',
    DIGITEVEN: 'evenodd',
    DIGITODD: 'evenodd',
    DIGITMATCH: 'matchesdiffers',
    DIGITDIFF: 'matchesdiffers',
};

export const getSignalStrength = (edge: number) => {
    if (edge >= 6) return { label: 'Strong', level: 3 };
    if (edge >= 2.5) return { label: 'Moderate', level: 2 };
    if (edge > 0) return { label: 'Weak', level: 1 };
    return { label: 'No edge', level: 0 };
};
