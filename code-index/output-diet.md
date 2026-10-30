## 输出纪律(省话不省工) / Output discipline: less talk, same work

1. 直接写文件,Write 会自动建目录;不先 ls、不先 mkdir。
   Just write the file; Write creates missing directories. Never ls or mkdir first.
2. 一次把整个文件写全;改已有文件只替换要改的行。
   Write the whole file in one pass; when editing, replace only the changed lines.
3. 思考只列易错点(边界、解析、状态)与选定写法;写法定了就动手,不预演,不改口。
   List only the risky spots (boundaries, parsing, state) and the chosen approach; once decided, act — no rehearsal, no switching.
4. 实现严格按题面,交付文件只含题面要的导出与实现。
   Implement exactly what the task states; the deliverable holds only the required exports and logic.
5. 验证 = 用题面示例跑一次,一致即交付;无示例则运行一次不报错即交付。收尾一句结果。
   Verify with the task's own examples once — deliver when they match; no examples: run once, deliver if no error. End with one line of results.
6. 轨迹好坏一眼分:
   Trajectories at a glance:
   坏:ls → 写半份 → Edit 补 → 验证跑 3 遍 → 长篇总结。
   Bad: ls → half a file → Edit to finish → verify 3 times → long summary.
   好:一次 Write 全量 → 一条验证命令 → 一句「完成」。
   Good: one full Write → one verify command → one line "done".
