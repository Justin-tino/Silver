/**
 * public/js/priority-engine.js
 * ---------------------------------------------------------------------------
 * SilverCare Rule-Based Priority Scoring Engine (Decision-Support ONLY).
 *
 * The panel explicitly rejected black-box "AI-assisted" prioritization.
 * This engine implements the OFFICIAL, predefined criteria approved by
 * OSCA using a transparent, weighted rule-based scoring system:
 *
 *   Criterion                     Weight   Rule
 *   ---------------------------------------------------------------
 *   Age                            25      Higher age = higher priority
 *   Health Condition               25      Critical illness = high priority
 *   Urgency of Request             20      Emergency cases = high priority
 *   Disability Status (PWD)        15      PWD senior = high priority
 *   Registration/Document Status   15      Complete documents = eligible
 *   ---------------------------------------------------------------
 *   TOTAL                         100
 *
 * Classification:
 *   0) OSCA STAFF DECISION (checked FIRST): when OSCA staff have reviewed the
 *      senior's uploaded medical certification and set the priority level
 *      themselves (users/{uid}/staffPriorityLevel), that HUMAN decision is
 *      authoritative — it overrides the automatic rules below.
 *   1) HEALTH OVERRIDE (checked next): any reported illness → High priority,
 *      even when the senior's age does not pass the milestone criteria.
 *   2) OSCA milestone age rule (otherwise, the senior's AGE solely
 *      determines the category):
 *      age <= 89  → Low
 *      age 90-99  → Medium
 *      age >= 100 → High (always, centenarian)
 * The weighted score below is retained for transparency and is adjusted to
 * fall within the mandated category's band so the displayed score always
 * matches the level shown.
 *
 * The output ALWAYS includes human-readable reasons so staff can justify
 * every ranking. It only RECOMMENDS — it never approves, releases, or
 * denies benefits. Final decisions remain with authorized OSCA personnel.
 */

const PRIORITY_CRITERIA_DOC = [
    { criterion: 'Age', weight: 25, rule: '60–64: 5 • 65–69: 10 • 70–74: 15 • 75–79: 20 • 80+: 25 • Milestone (category): 90–99 → Medium, 100+ → High' },
    { criterion: 'Health Condition', weight: 25, rule: 'Any reported illness → automatic High priority (health override). Critical illness (bedridden/stroke/heart disease/cancer/dementia/paralyzed): 25 • Chronic illness (hypertension/diabetes/asthma/arthritis): 15 • None reported: 0' },
    { criterion: 'Urgency of Request', weight: 20, rule: 'Emergency/urgent pending request: 20 • Standard pending request: 10 • No pending request: 0' },
    { criterion: 'Disability Status (PWD)', weight: 15, rule: 'PWD / mobility-impaired senior: 15 • Otherwise: 0' },
    { criterion: 'Registration & Document Status', weight: 15, rule: 'Identity verified + complete documents: 15 • Verified but with pending documents: 7 • Unverified: 0' }
];

const PRIORITY_THRESHOLDS = { high: 70, medium: 45 };

const CRITICAL_CONDITIONS = ['bedridden', 'stroke', 'heart disease', 'heart failure', 'cancer', 'dementia', 'alzheimer', 'paralyzed', 'kidney failure', 'dialysis', 'critical'];
const CHRONIC_CONDITIONS = ['hypertension', 'diabetes', 'asthma', 'arthritis', 'chronic', 'copd', 'tuberculosis'];

function computeSeniorAge(dob) {
    if (!dob) return null;
    const b = new Date(dob);
    if (isNaN(b.getTime())) return null;
    const t = new Date();
    let age = t.getFullYear() - b.getFullYear();
    const m = t.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
    return age;
}

/**
 * @param {object} user  Senior citizen record from the database
 * @param {object} [ctx] Optional context: { pendingRequestTypes: string[], urgentRequest: boolean }
 * @returns {{score:number, level:'High'|'Medium'|'Low', breakdown:Object, reasons:string[]}}
 */
function computePriority(user, ctx = {}) {
    const breakdown = {};
    const reasons = [];

    // 1) AGE (max 25)
    const age = computeSeniorAge(user.dob) || Number(user.age) || 0;
    let ageScore = 0;
    if (age >= 80) ageScore = 25;
    else if (age >= 75) ageScore = 20;
    else if (age >= 70) ageScore = 15;
    else if (age >= 65) ageScore = 10;
    else if (age >= 60) ageScore = 5;
    breakdown.age = ageScore;
    if (ageScore > 0) reasons.push(`Age ${age} (+${ageScore} pts)`);

    // 2) HEALTH CONDITION (max 25)
    const cond = String(user.healthCondition || user.condition || user.preExistingConditions || '').toLowerCase();
    let healthScore = 0;
    const criticalHit = CRITICAL_CONDITIONS.find(c => cond.includes(c));
    const chronicHit = CHRONIC_CONDITIONS.find(c => cond.includes(c));
    if (criticalHit) {
        healthScore = 25;
        reasons.push(`Critical health condition (${criticalHit}) (+25 pts)`);
    } else if (chronicHit) {
        healthScore = 15;
        reasons.push(`Chronic health condition (${chronicHit}) (+15 pts)`);
    }
    breakdown.health = healthScore;

    // 3) URGENCY OF REQUEST (max 20)
    let urgencyScore = 0;
    if (ctx.urgentRequest) {
        urgencyScore = 20;
        reasons.push('Has an URGENT pending assistance request (+20 pts)');
    } else if ((ctx.pendingRequestTypes || []).length > 0) {
        urgencyScore = 10;
        reasons.push(`Pending request(s): ${ctx.pendingRequestTypes.join(', ')} (+10 pts)`);
    }
    breakdown.urgency = urgencyScore;

    // 4) DISABILITY STATUS / PWD (max 15)
    let disabilityScore = 0;
    const isPwd = user.isPwd === true || user.pwdId || /pwd|disab|mobility|orthoped|visual impair|hearing impair/i
        .test(String(user.disability || user.disabilityDetails || cond));
    if (isPwd) {
        disabilityScore = 15;
        reasons.push('Registered as PWD / with disability (+15 pts)');
    }
    breakdown.disability = disabilityScore;

    // 5) REGISTRATION & DOCUMENT STATUS (max 15)
    const kycVerified = user.kycStatus === 'Verified' || !!user.kycVerifiedAt;
    const hasSeniorId = !!String(user.seniorId || '').trim();
    const idDocs = user.idDocuments ? Object.values(user.idDocuments) : [];
    const hasPendingDocs = idDocs.some(d => d.status === 'Pending');
    let regScore = 0;
    if (kycVerified && hasSeniorId && !hasPendingDocs) {
        regScore = 15;
    } else if (kycVerified && hasPendingDocs) {
        regScore = 7;
        reasons.push('Verified but has pending document(s) (+7 pts)');
    } else {
        reasons.push('Identity verification incomplete (+0 pts)');
    }
    breakdown.registration = regScore;

    const score = ageScore + healthScore + urgencyScore + disabilityScore + regScore;

    // ── CLASSIFICATION ──
    //   0) OSCA STAFF DECISION (checked FIRST): priority set by staff after
    //      reviewing the uploaded medical certification — a human decision is
    //      authoritative and overrides the automatic rules below.
    //   1) HEALTH OVERRIDE (checked next): a reported illness → High priority
    //      even when the senior's age does not pass the milestone criteria.
    //   2) OSCA milestone age rule (age solely determines the category otherwise):
    //      age <= 89  → Low
    //      age 90-99  → Medium
    //      age >= 100 → High (centenarian)
    // NOTE: the High check must come FIRST — testing "age >= 99" before it
    // would wrongly classify centenarians (100+) as Medium.
    const hasIllness = !!cond && !/none/.test(cond) && !/healthy/.test(cond) && !/no illness/.test(cond);
    const staffPriority = String(user.staffPriorityLevel || '').trim();
    let level;
    if (['Low', 'Medium', 'High'].includes(staffPriority)) {
        level = staffPriority;
        reasons.push(`OSCA staff-assigned priority (${staffPriority}) after reviewing the medical certification — human decision overrides the automatic rules`);
    } else if (hasIllness) {
        level = 'High';
        reasons.push('Reported illness / health condition → High priority (health override, regardless of age)');
    } else if (age >= 100) {
        level = 'High';
        reasons.push(`OSCA milestone rule: age ${age} (100+) → High priority`);
    } else if (age >= 90) {
        level = 'Medium';
        reasons.push(`OSCA milestone rule: age ${age} (90-99) → Medium priority`);
    } else {
        level = 'Low';
    }

    // Keep the displayed score within the age-based category's band so the
    // score shown always matches the level shown (High: 70-100, Medium: 45-69, Low: 0-44)
    const PRIORITY_BANDS = { Low: [0, 44], Medium: [45, 69], High: [70, 100] };
    const [bandMin, bandMax] = PRIORITY_BANDS[level];
    let finalScore = Math.min(Math.max(score, bandMin), bandMax);
    if (finalScore !== score) {
        reasons.push(`Score adjusted to ${finalScore}/100 to match ${level} priority band (age-based category)`);
    }

    reasons.push(`Total score: ${finalScore}/100 → ${level} priority`);

    // NOTE: the score is an internal decision-support metric only.
    // The UI displays ONLY the age-based level (Low / Medium / High) —
    // numeric scores are never shown to staff or seniors.
    return { score: finalScore, level, breakdown, reasons };
}

/** Convenience wrapper returning only the classification level. */
function priorityLevel(user, ctx) {
    return computePriority(user, ctx).level;
}

// CommonJS export — the Express backend loads this file with require().
// Plain CJS keeps the server boot-safe on every Node version.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PRIORITY_CRITERIA_DOC,
        PRIORITY_THRESHOLDS,
        computeSeniorAge,
        computePriority,
        priorityLevel
    };
}
