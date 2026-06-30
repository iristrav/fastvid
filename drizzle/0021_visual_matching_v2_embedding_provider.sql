ALTER TABLE `embedding_cache` ADD `provider` varchar(64) NOT NULL DEFAULT 'voyage';
--> statement-breakpoint
ALTER TABLE `media_archive_asset_embeddings` ADD `provider` varchar(64) NOT NULL DEFAULT 'voyage';
