package main

import (
	"context"
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/config"
	"github.com/vincentmegia/vincentmegia/internal/db"
	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// TestResumeAdminRoundTrip exercises every /settings/resume write path
// (docs/features/resume-content-authoring.md) directly against
// ResumeService/ResumeRepository over a real Postgres instance — the same
// DATABASE_URL/.env gating as TestEndToEnd (skipped, not failed, when no
// database is reachable). It goes through the service layer rather than
// real HTTP requests because every /settings/resume route requires
// IsAuthenticated, which is permanently stubbed to false
// (internal/handler/auth_stub.go) — TestEndToEnd's "settings routes
// require auth" subtest already proves the route is gated; this test
// proves the persistence logic behind that gate is correct.
//
// This test mutates the real resume_profile singleton row and inserts a
// throwaway resume_roles row, so it restores the original profile content
// via t.Cleanup (runs even on failure) and deletes the role it created —
// this must never leave the shared dev database's actual seeded résumé
// content permanently altered.
func TestResumeAdminRoundTrip(t *testing.T) {
	chdirRepoRoot(t)

	cfg, err := config.Load()
	if err != nil {
		t.Skipf("config.Load(): %v (skipping — see .env.example)", err)
	}

	ctx := context.Background()
	conn, err := db.Open(ctx, cfg.DatabaseURL, cfg.DBMaxOpenConns)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	// Registered before the restore-original-content Cleanup below so it
	// runs after it: t.Cleanup fires in last-added-first-called order, and
	// closing the connection before the restore write would run has run
	// would fail every restore call with "database is closed."
	t.Cleanup(func() { conn.Close() })

	repo := repository.NewResumeRepository(conn, conn)
	svc := service.NewResumeService(repo)

	original, err := repo.GetProfile(ctx)
	if err != nil {
		t.Fatalf("get original profile: %v", err)
	}
	t.Cleanup(func() {
		if err := repo.UpdateBanner(ctx, original.RoleTitle, original.TenureLabel, original.LocationLabel, original.ContactLinks, original.BannerFontStyle); err != nil {
			t.Errorf("restore original banner: %v", err)
		}
		if err := repo.UpdateExpertise(ctx, original.SkillGroups, original.SidebarExpertiseFontStyle); err != nil {
			t.Errorf("restore original expertise: %v", err)
		}
		if err := repo.UpdateEducation(ctx, original.Education, original.SidebarEducationFontStyle); err != nil {
			t.Errorf("restore original education: %v", err)
		}
		if err := repo.UpdateFeaturedProjects(ctx, original.FeaturedProjects, original.SidebarFeaturedProjectsFontStyle); err != nil {
			t.Errorf("restore original featured projects: %v", err)
		}
		if err := repo.UpdateSummary(ctx, original.SummaryParagraphs, original.Stats, original.SummaryFontStyle); err != nil {
			t.Errorf("restore original summary: %v", err)
		}
	})

	t.Run("banner saves and renders with its font class", func(t *testing.T) {
		view, err := svc.SaveBanner(ctx, "TEST Role Title", "TEST tenure", "TEST location",
			[]model.ContactLink{{Label: "Test", Href: "https://example.com", Icon: "globe"}}, "classic-serif")
		if err != nil {
			t.Fatalf("SaveBanner: %v", err)
		}
		if view.Error != "" {
			t.Fatalf("SaveBanner validation error: %s", view.Error)
		}

		rendered, err := svc.Get(ctx)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if rendered.RoleTitle != "TEST Role Title" {
			t.Errorf("rendered RoleTitle = %q, want %q", rendered.RoleTitle, "TEST Role Title")
		}
		if rendered.BannerFontClass != "resume-font-classic-serif" {
			t.Errorf("BannerFontClass = %q, want resume-font-classic-serif", rendered.BannerFontClass)
		}
	})

	t.Run("banner rejects an invalid font style and persists nothing", func(t *testing.T) {
		before, _ := svc.Get(ctx)
		view, err := svc.SaveBanner(ctx, "SHOULD NOT PERSIST", "x", "y", nil, "not-a-real-preset")
		if err != nil {
			t.Fatalf("SaveBanner: %v", err)
		}
		if view.Error == "" {
			t.Fatal("expected a validation error for an invalid font style, got none")
		}
		after, _ := svc.Get(ctx)
		if after.RoleTitle != before.RoleTitle {
			t.Errorf("RoleTitle changed despite validation failure: %q -> %q", before.RoleTitle, after.RoleTitle)
		}
	})

	t.Run("expertise saves and renders with its font class", func(t *testing.T) {
		view, err := svc.SaveExpertise(ctx, []model.SkillGroup{{Name: "TEST Group", Skills: []string{"TEST Skill"}}}, "modern-sans")
		if err != nil || view.Error != "" {
			t.Fatalf("SaveExpertise: err=%v view.Error=%q", err, view.Error)
		}
		rendered, err := svc.Get(ctx)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if len(rendered.SkillGroups) != 1 || rendered.SkillGroups[0].Name != "TEST Group" {
			t.Errorf("SkillGroups = %+v", rendered.SkillGroups)
		}
		if rendered.SidebarExpertiseFontClass != "resume-font-modern-sans" {
			t.Errorf("SidebarExpertiseFontClass = %q, want resume-font-modern-sans", rendered.SidebarExpertiseFontClass)
		}
	})

	t.Run("education saves", func(t *testing.T) {
		view, err := svc.SaveEducation(ctx, []model.Education{{Degree: "TEST Degree", School: "TEST School", StartYear: 2000, EndYear: 2004}}, "editorial")
		if err != nil || view.Error != "" {
			t.Fatalf("SaveEducation: err=%v view.Error=%q", err, view.Error)
		}
	})

	t.Run("featured projects saves", func(t *testing.T) {
		view, err := svc.SaveFeaturedProjects(ctx, []model.FeaturedProject{{Name: "TEST Project", Description: "TEST Description"}}, "organic")
		if err != nil || view.Error != "" {
			t.Fatalf("SaveFeaturedProjects: err=%v view.Error=%q", err, view.Error)
		}
	})

	t.Run("summary saves", func(t *testing.T) {
		view, err := svc.SaveSummary(ctx, []string{"TEST paragraph"}, []model.Stat{{Num: "1", Label: "TEST stat"}}, "classic-serif")
		if err != nil || view.Error != "" {
			t.Fatalf("SaveSummary: err=%v view.Error=%q", err, view.Error)
		}
	})

	t.Run("role create, update, move, and delete round-trip", func(t *testing.T) {
		listView, err := svc.CreateRole(ctx, "TEST Role", "TEST-ROLE-DELETE-ME", "", "2020-01-01", "", "TEST blurb",
			[]string{"TEST bullet"}, nil, "organic")
		if err != nil {
			t.Fatalf("CreateRole: %v", err)
		}
		if listView.Error != "" {
			t.Fatalf("CreateRole validation error: %s", listView.Error)
		}

		var createdID int64
		for _, r := range listView.Roles {
			if r.Company == "TEST-ROLE-DELETE-ME" {
				createdID = r.ID
			}
		}
		if createdID == 0 {
			t.Fatal("created role not found in refreshed list")
		}
		t.Cleanup(func() {
			if _, err := svc.DeleteRole(ctx, createdID); err != nil {
				t.Errorf("cleanup delete role %d: %v", createdID, err)
			}
		})

		listView, err = svc.UpdateRole(ctx, createdID, "TEST Role Updated", "TEST-ROLE-DELETE-ME", "", "2020-01-01", "2021-01-01", "",
			nil, []model.Subproject{{Heading: "TEST Sub", Bullets: []string{"TEST sub bullet"}}}, "modern-sans")
		if err != nil {
			t.Fatalf("UpdateRole: %v", err)
		}
		if listView.Error != "" {
			t.Fatalf("UpdateRole validation error: %s", listView.Error)
		}

		rendered, err := svc.Get(ctx)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		var found bool
		for _, r := range rendered.Roles {
			if r.ID != createdID {
				continue
			}
			found = true
			if r.Title != "TEST Role Updated" {
				t.Errorf("Title = %q, want %q", r.Title, "TEST Role Updated")
			}
			if r.IsCurrent {
				t.Error("a role with a non-nil end date should not render as current")
			}
			if r.FontClass != "resume-font-modern-sans" {
				t.Errorf("FontClass = %q, want resume-font-modern-sans", r.FontClass)
			}
			if len(r.Subprojects) != 1 || r.Subprojects[0].Heading != "TEST Sub" {
				t.Errorf("Subprojects = %+v", r.Subprojects)
			}
		}
		if !found {
			t.Fatal("updated role not found in the rendered resume view")
		}

		if _, err := svc.MoveRole(ctx, createdID, "up"); err != nil {
			t.Fatalf("MoveRole: %v", err)
		}
	})

	t.Run("role create rejects a malformed date", func(t *testing.T) {
		listView, err := svc.CreateRole(ctx, "X", "Y", "", "not-a-date", "", "", nil, nil, "organic")
		if err != nil {
			t.Fatalf("CreateRole: %v", err)
		}
		if listView.Error == "" {
			t.Fatal("expected a validation error for a malformed start date, got none")
		}
	})
}
