# Performance Review brief

Identify changed hot paths and the workload that exercises them. Look for higher algorithmic complexity, N+1 data access, repeated work, unbounded loops or allocations, unnecessary I/O, contention, cache invalidation, missing pagination, and regressions in resource use. Connect each concern to a user-visible or system-level metric and the actual changed code.

Report only performance or resource findings. Do not repeat correctness or security findings that lack a performance consequence. An empty findings array is appropriate when the change has no supported performance issue.

Separate a demonstrated regression from a possible optimization. Do not invent latency, throughput, memory, or benchmark numbers. State workload assumptions and a practical way to measure the effect. If no workload or benchmark evidence is supplied, report that limitation only when it materially affects the change assessment.
