/**
 * Chinese one-line explanation for the tool each engine state recommends.
 * Shared by the panel and slash commands so both surfaces speak the same
 * language; unknown tools fall back to the engine's own reason.
 */
export const NEXT_DETAILS: Record<string, string> = {
  novel_init: '先建立一本书的项目根目录。',
  novel_guide: '按当前状态查看下一步该做什么。',
  novel_status: '查看当前章节、阶段、阻塞与下一步。',
  novel_brief: '先领取当前阶段的任务书，再提交内容。',
  novel_blueprint: '补全书名之外的前提、主题、视角与卷结构。',
  novel_outline: '规划卷与章卡；严格模式下每章必须先有卡。',
  novel_outline_import: '从 Markdown、YAML 或 JSON 导入现成大纲。',
  novel_worldbook: '写设定、规则、势力、地点与角色小传。',
  novel_search: '跨正文、摘要、大纲、世界观与台账搜索。',
  novel_doctor: '检查项目、日志、索引、正文与规划是否一致。',
  novel_report: '查看全书进度、质量、节奏、角色与伏笔。',
  novel_plan_world: '为新章节写下世界观约束与角色关系。',
  novel_plan_chapter: '把本章拆成可执行的节拍与断章点。',
  novel_write_draft: '按任务书写出本章初稿。',
  novel_review: '按十五维给本章打分并标出问题。',
  novel_revise: '处理评审意见后提交修订。',
  novel_check: '核对场景、角色、因果与声音一致性。',
  novel_archive: '通过终审后归档本章。',
  novel_reopen: '从归档备份重开上一章。',
  novel_rollback: '回退到更早阶段重建当前章。',
  novel_amend: '按明确的修复理由修正一份状态文档。',
  novel_audit: '先查看事务日志，确认并恢复损坏的历史。',
  novel_export: '导出成书或书级提案。',
  novel_diff: '对比当前正文与上一版或给定文本。',
  novel_word_count: '按引擎字数口径核对正文长度。',
}
