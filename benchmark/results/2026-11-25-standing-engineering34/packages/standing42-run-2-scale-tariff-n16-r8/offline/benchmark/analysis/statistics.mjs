export const STATISTICS_VERSION = '1.0.0';
export const INTERVAL_METHOD = 'weighted-cluster-hoeffding-v1';
export const BOUNDARY_METHOD = 'hoeffding-no-degenerate-bootstrap-v1';
export const MULTIPLICITY_METHOD = 'bonferroni-primary-family-v1';

/** Independent bounded cluster sums; repeat and case weights are fixed before outcomes. */
export function clusterInterval(rows, { lower = 0, upper = 1, confidence = 0.95, comparisons = 1 } = {}) {
  if (!(upper > lower) || !(confidence > 0 && confidence < 1) || !Number.isSafeInteger(comparisons) || comparisons < 1)
    throw new TypeError('Invalid bounded interval policy');
  if (!rows.length) return { status: 'unavailable', reason: 'No independent clusters', method: INTERVAL_METHOD };
  let weight = 0, point = 0; const clusters = new Map();
  for (const row of rows) {
    if (typeof row.cluster_id !== 'string' || !row.cluster_id || !Number.isFinite(row.weight) || row.weight <= 0 ||
        !Number.isFinite(row.value) || row.value < lower - 1e-12 || row.value > upper + 1e-12)
      throw new TypeError('Cluster interval requires bounded observations and positive fixed weights');
    weight += row.weight; point += row.weight * row.value;
    clusters.set(row.cluster_id, (clusters.get(row.cluster_id) ?? 0) + row.weight);
  }
  if (Math.abs(weight - 1) > 1e-9) throw new TypeError('Fixed case weights must sum to one');
  const sumSquares = [...clusters.values()].reduce((sum,w)=>sum+w*w,0);
  const alpha = (1-confidence)/comparisons;
  const radius = (upper-lower)*Math.sqrt(Math.log(2/alpha)*sumSquares/2);
  return { status: 'available', method: INTERVAL_METHOD, confidence, comparisons, adjusted_alpha: alpha,
    estimate: point, lower: Math.max(lower, point-radius), upper: Math.min(upper, point+radius),
    radius, clusters: clusters.size, effective_clusters: 1/sumSquares, cluster_weight_squares: sumSquares,
    assumptions: ['Clusters are independent sampling units.', 'Case, family and cluster assignments were fixed before outcomes.',
      'Within-cluster dependence is unrestricted; repeats add no independent cluster.'],
    boundary_method: BOUNDARY_METHOD };
}
export function differenceInterval(rows, options = {}) {
  return clusterInterval(rows, { ...options, lower: -1, upper: 1 });
}
export function ratioInterval(numerator, denominator, { confidence = 0.95, comparisons = 1, upper } = {}) {
  if (!Number.isFinite(upper) || upper <= 0) return { status: 'unavailable', reason: 'No predeclared finite range for this resource' };
  const a = clusterInterval(numerator,{lower:0,upper,confidence,comparisons:comparisons*2});
  const b = clusterInterval(denominator,{lower:0,upper,confidence,comparisons:comparisons*2});
  if (a.status !== 'available' || b.status !== 'available') return {status:'unavailable',reason:'Missing ratio means'};
  const absolute_difference = a.estimate-b.estimate;
  if (b.estimate === 0) return { status:'undefined',reason:'Zero reference mean',estimate:null,absolute_difference,numerator:a,denominator:b };
  if (b.lower <= 0) return { status:'unbounded',reason:'Reference confidence interval includes zero',estimate:a.estimate/b.estimate,
    lower:a.lower/b.upper,upper:null,absolute_difference,numerator:a,denominator:b };
  return { status:'available', estimate:a.estimate/b.estimate, lower:a.lower/b.upper, upper:a.upper/b.lower,
    absolute_difference,numerator:a,denominator:b,method:'bonferroni-joint-bounded-means/v1' };
}
export function weightedMean(rows) {
  if (!rows.length) return null;
  const weight = rows.reduce((sum,row)=>sum+row.weight,0);
  if (Math.abs(weight-1)>1e-9 || rows.some(row=>!Number.isFinite(row.value))) throw new TypeError('Weighted mean needs all fixed-weight values');
  return rows.reduce((sum,row)=>sum+row.weight*row.value,0);
}
export function weightedQuantile(rows, probability) {
  if (!(probability > 0 && probability <= 1)) throw new TypeError('Invalid quantile probability');
  const ordered = [...rows].sort((a,b)=>a.value-b.value);
  let sum = 0;
  for (const row of ordered) { sum += row.weight; if (sum + 1e-12 >= probability) return row.value; }
  return null;
}
