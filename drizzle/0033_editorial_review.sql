-- Editorial Review: post-render documentary quality assessment store
CREATE TABLE IF NOT EXISTS `editorial_reviews` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `videoId`          VARCHAR(128) NOT NULL,
  `videoTitle`       VARCHAR(512),
  `overallScore`     TINYINT UNSIGNED NOT NULL,
  `scores`           JSON NOT NULL,
  `sourcing`         JSON NOT NULL,
  `feedback`         JSON NOT NULL,
  `autoImprovements` JSON NOT NULL,
  `topIssues`        JSON NOT NULL,
  `createdAt`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `editorial_reviews_videoId_idx` (`videoId`),
  INDEX `editorial_reviews_created_idx` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
