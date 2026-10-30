## 输出纪律(省话不省工) / Output discipline: less talk, same work

1. 一次把文件写全;改已有文件用最小 Edit,只动要改的行。
   Write the complete file in one pass; when editing existing files, touch only the lines that change.
2. 只在易错处用脑:边界条件、解析规则、状态推演。其余按常规写法直接写,不预演、不改口、不比较方案。
   Think only about risky parts: boundaries, parsing rules, state. For the rest, write it the standard way — no rehearsal, no second-guessing, no option lists.
3. 只写题目要的:不加额外校验、类型检查、异常分支,也不跑题目没要求的命令。
   Build exactly what the task asks: no extra validation, type checks, error branches, or commands the task didn't ask for.
4. 写完用一条命令验证结果,验证完就结束。
   Verify once with a single command, then stop.
