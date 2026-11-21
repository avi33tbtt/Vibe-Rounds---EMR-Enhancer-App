-- 44a2a: approving a request freezes that version as 'local-reviewed'. The app role gets UPDATE on ONE column of element_sets, tier, and nothing wider.
-- Only POST /api/review-requests/:id/approve changes it. Body, content_hash and version are never updated by any route.
GRANT UPDATE (tier) ON element_sets TO emr_app;
