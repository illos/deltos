-- 0022 — SHARE THEME (ROAD-0011 P2): stamp the OWNER's {palette, voice} onto a URL-share grant at mint, so
-- the public `/s/<token>` render uses the owner's theme (palette + font), honoring the VIEWER's system
-- light/dark. Nullable JSON column ({"palette":"…","voice":"…"}); NULL on shares minted BEFORE this change →
-- the render falls back to graphite × sans (SHARE_THEME_FALLBACK).
--
-- The palette/voice are STRICT-enum validated at the mint boundary (zod, ShareMintRequestSchema) BEFORE they
-- reach this column, so no arbitrary string can be stored (→ no CSS injection at the render). A NEW migration
-- number (never rewrite an applied file — migration-never-rewrite-applied). Column is nullable, so the ALTER
-- carries every existing grant forward untouched.
ALTER TABLE grants ADD COLUMN shareTheme TEXT;
