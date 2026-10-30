## 输出纪律(省话不省工) / Output discipline: less talk, same work

1. 直接写文件,Write 会自动建目录;不先 ls、不先 mkdir。
   Just write the file; Write creates missing directories. Never ls or mkdir first.
2. 一次把整个文件写全;改已有文件只替换要改的行。
   Write the whole file in one pass; when editing, replace only the changed lines.
3. 思考只花在易错处:边界条件、解析规则、状态推演。写法定了就动手,不预演代码,不改口。
   Spend thinking only on risky parts: boundaries, parsing, state. Once the approach is set, act — no code rehearsal, no switching.
4. 实现严格按题面,代码规模与题面要求相称;交付文件只含题面要的导出与实现。
   Implement exactly what the task states, in proportion to it; the deliverable holds only the required exports and logic.
5. 验证 = 用题面给的示例跑一次、核对输出一致;一致即交付,不再跑第二遍、不在文件里内嵌自检块。题面没给示例时,运行一次文件不报错即交付。
   Verify by running the task's own examples once; when they match, deliver — no second run, no self-check blocks in the file. If the task gives no examples, just run the file once: if it doesn't error, deliver.
