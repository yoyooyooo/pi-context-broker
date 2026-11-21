# FreshnessPublication

TLC reached 164 states and 295 steps. The chart draws 11 states and 19 arrows.
The chart does not draw 178 steps that stay in one chart state.

## ExpiredCacheCannotPublish breaks
The shortest path has 2 steps:
0. 等待原始证据与发布校验
1. 到达原缓存有效期: 缓存已到原有效期，等待后续结果
2. 结果到达：缺失守卫导致错误发布: 违例：过期缓存被发布 / root available / 依赖 unknown

## Rules that hold
TypeOK, CacheValidationNotRenewed, FixedContentIsNotCurrent, NewerEvidenceSurvives, NoRetiredPublication, NoCancelledPublication, ScopeIsExact, DependencyFailureIsLocal, UnknownIsNotPermission, NoDeadlock
