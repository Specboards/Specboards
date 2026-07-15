ALTER TABLE "board_preferences" DROP CONSTRAINT "board_preferences_ws_user_uq";--> statement-breakpoint
ALTER TABLE "board_preferences" ADD COLUMN "board" text DEFAULT 'backlog' NOT NULL;--> statement-breakpoint
ALTER TABLE "board_preferences" ADD CONSTRAINT "board_preferences_ws_user_board_uq" UNIQUE("workspace_id","user_id","board");