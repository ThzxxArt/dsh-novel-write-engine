-- 0.3.0 review resolution evidence: a blocker marked fixed must quote the
-- current draft sentence that closes it. Advisory waivers may leave it NULL.
ALTER TABLE review_finding ADD COLUMN resolution TEXT;
