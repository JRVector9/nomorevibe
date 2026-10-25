# Direct provider reboot boundary implementation plan

Root approved exact bfe0c8fc V3 direct Linux native host reboot support. Preserve V1/V2, immutable request/binding, unknown usage and writer/control/request locks. Full native serving contract/IP/machine/node/boot association, authoritative owner/local-end DB records and DB-clock sandwich of CLOCK_BOOTTIME are required. Provider current process stop0. Root owns all production operations.

- [ ] New boot fixture/unit tests; run old V1/V2 RED before production edits.
- [ ] Focused strict V3 schema, microsecond DB timestamps/nanosecond uptime interval arithmetic; same machine/boot witness after original owner actual namespace exit, exactlyzero gateways.
- [ ] Real PG130→131 migration with nonempty local direct request/owner-group/local-end facts. Old validator rejects new evidence; new0130 validator/trigger rechecks all records and leaves old functions/constraints intact.
- [ ] Capacity/CLI wiring; prove directSQL negative equivalence, dryrunrollback, exactone row/event/audit, replay and no usage/settled/businessresult.
- [ ] GPU readonly collector field agreement with search_profile private owner-only root-operated helper. No production stop/release/config/DDL/modelcalls.
- [ ] Scoped old/new boundary unit+integration, Nexttypegen/tsc/ESLint/diffcheck; record actual RED/GREEN/failures in operation note; commit/diffreview to root before singlepush/PR.

Operations order: mainCI/images → draining/legitimatecallreconcile →0130 once+journal131/hashverify → exactoriginalownerplan → ownercutoff → freshsamebootreceipt → dryrun/apply/readback → ownerrestore/open → regularnewcodedeploy.
