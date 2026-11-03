# CI latency experiment (2026-11-03)

## Baseline

Latest-head pull-request runs sampled for PRs #50–59. These are ten sampled runs, not the ten consecutive repository runs. Times below are seconds from first to last timestamp in each job log, so exclude queue time before the runner starts. Span includes the final platform gate. No queue-duration claim is made because the connector does not return run-created/job-started metadata.

| PR  | Run                                                                                         | Static | Integration | Browser 1 | Browser 2 | Span |
| --- | ------------------------------------------------------------------------------------------- | -----: | ----------: | --------: | --------: | ---: |
| #59 | [41662644783](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41662644783) |    116 |         512 |       983 |       877 |  994 |
| #58 | [41666897600](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41666897600) |    165 |         588 |       879 |       918 |  924 |
| #57 | [41659057610](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41659057610) |    178 |         656 |       502 |       665 |  673 |
| #56 | [41667011152](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41667011152) |    164 |         646 |       870 |       963 |  970 |
| #55 | [41649503524](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41649503524) |    119 |         698 |       727 |      1033 | 1040 |
| #54 | [41642135969](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41642135969) |    132 |         510 |       624 |       945 |  951 |
| #53 | [41632812142](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41632812142) |    100 |         653 |       975 |       322 |  981 |
| #52 | [41626360432](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41626360432) |    160 |         601 |      1134 |       367 | 1141 |
| #51 | [41617418844](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41617418844) |    169 |         536 |       792 |       385 |  799 |
| #50 | [41639100902](https://github.com/Astrocore-Technologies/Dreamwalk/actions/runs/41639100902) |    161 |         661 |       643 |       705 |  711 |

Browser jobs were the critical path in every sampled run. Existing workflow already avoids feature-push/PR duplication, cancels superseded same-PR runs, uses npm download caching, and keeps isolated single-worker browser shards. npm cache hits were observed in every sampled substantive job. The platform aggregate itself takes 0–2 seconds. One Vercel status was observed on #58, not duplicate Vercel checks.

The #58 browser-2 setup included approximately 50 seconds npm ci, 21 seconds browser installation, 25 seconds launcher readiness, and 13.2 minutes Playwright. Integration's longest step was game integration (~342 seconds). Browser long journeys include four-player adventure completion (~282 seconds) and director (~210 seconds); these retain privacy, multiplayer and renderer coverage. #50 had three retried flaky browser tests; #57 had one. Retries and evidence are preserved.

## Controlled change

Build the web bundle from the exact checkout inside each browser job, then run Next start rather than Next dev. Keep API NODE_ENV=development and the existing mock gates, credential separation, disposable database, migrations, seeding, one browser worker, both shards, all assertions and timeouts. The production NODE_ENV applies only to the web child. Reject missing build output before database startup. No cross-commit build cache or shared database is introduced.

Expected tradeoff: each browser job adds a web compilation (roughly tens of seconds based on the existing full-build step), but avoids lazy route compilation and development rendering overhead during every journey. Savings are not established until the exact-head CI run completes; runtime variation is large, so a single run is directional evidence rather than a guaranteed percentage. A regression or no material improvement warrants reverting this experiment, not removing tests or increasing timeouts.

No branch protections, required-check names, production settings, provider access, financial tests, or privacy coverage are changed. The five GitHub checks remain: collapsing them would mostly serialize work rather than remove cost. Vercel preview confirms deployability and is not equivalent to the browser or database test suites.
