# Record-mode pilot reports, 2026-10-28

Record mode. A local stub answers every model, embedding, rerank and guard call with fixed, deterministic replies, so these reports measure the harness's mechanics (routing, call capture, the deadline and failure handling, the report itself) and say nothing about how the arms compare. No vendor was called and no money was spent; the cost section reads "not run". The determinism gate's section reads "not run" as well: these reports carry no determinism record.

Section 3 of every report says that Z is reported in every table. Only legs 04 and 08 ran Z: the other eight reports show Z in the arms table alone, as not in the run, and their per-arm tables list only the arms that ran.

Section 10's table "Checks on this run" lists the runner's error rows one row per kind, so a run that holds none shows the stray connections alone. None of the ten runs holds an error row.

- Rendered by CI run 40723979292 of the private runner (public copies, scanned before upload).
- Runs: record-leg-1, record-leg-2, record-leg-3, record-leg-4, record-leg-5, record-leg-6, record-leg-7, record-leg-8, record-leg-9, record-leg-10.
- AgentOS 0.14.25; the agentos-bench gmi-vs-agent family (unpublished) at revision 8c0361f42073; protocol 0a SHA-256 10579b4e3eb9 as registered, and its addendum's SHA-256 684c21c83e02.

| Leg | Contents | Markdown | HTML | PDF | Header | Sizes | SHA-256 |
|---|---|---|---|---|---|---|---|
| 01 | Text quality (T4): 10 prompts on B and C0 | [report.md](leg-01/report.md) | [report.html](leg-01/report.html) | [report.pdf](leg-01/report.pdf) | [header](leg-01/report-header.public.json) | 12.9, 18.6, 172.9, 1.7 | a49bff19cbd9, 7fee4f48a519, e5ef92f4069c, 0824c42b854b |
| 02 | Persona conversation (T2): 1 conversation of 10 turns on B, C0 and C1 | [report.md](leg-02/report.md) | [report.html](leg-02/report.html) | [report.pdf](leg-02/report.pdf) | [header](leg-02/report-header.public.json) | 13.4, 19.7, 192.3, 1.7 | 73aaac9029e0, 6258e7e1427d, 42a9c0bda7b1, 0824c42b854b |
| 03 | Sentiment adaptation (T3): 1 script with an explicit frustration cue on B, B+S, C0 and C1 | [report.md](leg-03/report.md) | [report.html](leg-03/report.html) | [report.pdf](leg-03/report.pdf) | [header](leg-03/report-header.public.json) | 13.2, 19.4, 191.7, 1.7 | fb71bb8fcb9f, 86d65632632e, 5b24d78fc907, 0824c42b854b |
| 04 | Recall (T1): 5 LongMemEval-S questions, with ingestion, on B, C0, A and Z | [report.md](leg-04/report.md) | [report.html](leg-04/report.html) | [report.pdf](leg-04/report.pdf) | [header](leg-04/report-header.public.json) | 13.0, 19.0, 184.2, 1.7 | b8c7618e8cf5, daccec0181ed, 81faabb55c48, 0824c42b854b |
| 05 | Calibration (T4): B's clean replies to 20 calibration prompts | [report.md](leg-05/report.md) | [report.html](leg-05/report.html) | [report.pdf](leg-05/report.pdf) | [header](leg-05/report-header.public.json) | 12.8, 18.4, 167.2, 1.7 | a33d7b16f9f3, cd9ddde19b37, 23b9473e9ded, 0824c42b854b |
| 06 | Persona conversation (T2): 1 conversation over two sessions on B, C0 and C1 | [report.md](leg-06/report.md) | [report.html](leg-06/report.html) | [report.pdf](leg-06/report.pdf) | [header](leg-06/report-header.public.json) | 13.4, 19.7, 192.3, 1.7 | 6af372a65613, 3e03a86c2d9e, e891e67ec319, 0824c42b854b |
| 07 | Sentiment adaptation (T3): 1 script with an implicit confusion cue on B, B+S, C0 and C1 | [report.md](leg-07/report.md) | [report.html](leg-07/report.html) | [report.pdf](leg-07/report.pdf) | [header](leg-07/report-header.public.json) | 13.2, 19.4, 191.7, 1.7 | e5c44f059856, e04cbce64d93, 70bbf24885fe, 0824c42b854b |
| 08 | Recall (T1): 5 LOCOMO questions, with ingestion, on B, C0, A and Z | [report.md](leg-08/report.md) | [report.html](leg-08/report.html) | [report.pdf](leg-08/report.pdf) | [header](leg-08/report-header.public.json) | 13.0, 19.0, 184.1, 1.7 | aa16c21772b8, 0e84c96c7e97, 805c188cddb4, 0824c42b854b |
| 09 | A/A control (T4): second samples of B and C0 on leg 01's 10 prompts | [report.md](leg-09/report.md) | [report.html](leg-09/report.html) | [report.pdf](leg-09/report.pdf) | [header](leg-09/report-header.public.json) | 12.9, 18.6, 172.9, 1.7 | 7ece901534a8, ea322ee8bb69, b6e7603732ce, 0824c42b854b |
| 10 | Cold sessions (T3): the scripts of legs 03 and 07 on C0 and C1, with a new GMI on every turn | [report.md](leg-10/report.md) | [report.html](leg-10/report.html) | [report.pdf](leg-10/report.pdf) | [header](leg-10/report-header.public.json) | 13.4, 19.3, 180.6, 1.7 | a2610034e175, a95a2cf7fb2f, 1b723caa86a2, 0824c42b854b |

Sizes are in KB of 1,024 bytes and each SHA-256 is the hash's first 12 hex characters, both in the order markdown, HTML, PDF, header.

Legs dropped under the recorded drop order: none.

Legs without a report: none.

The HTML file of each leg (`report.html`) is the self-contained page the PDF was printed from; download it to view it in a browser.
