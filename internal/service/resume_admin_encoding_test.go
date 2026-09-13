package service

import "testing"

func TestDecodeLines(t *testing.T) {
	got := DecodeLines("First\n\n  Second  \n")
	if len(got) != 2 || got[0] != "First" || got[1] != "Second" {
		t.Errorf("DecodeLines = %#v, want [First Second]", got)
	}
}

func TestDecodeContactLinks(t *testing.T) {
	got := DecodeContactLinks("Email | mailto:x@y.com | mail\nWebsite | https://example.com |")
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Label != "Email" || got[0].Href != "mailto:x@y.com" || got[0].Icon != "mail" {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].Label != "Website" || got[1].Href != "https://example.com" || got[1].Icon != "" {
		t.Errorf("got[1] = %+v", got[1])
	}
}

func TestDecodeSkillGroups(t *testing.T) {
	got := DecodeSkillGroups("Backend: Go, Postgres, HTMX\nFrontend: HTML, CSS")
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Name != "Backend" || len(got[0].Skills) != 3 || got[0].Skills[2] != "HTMX" {
		t.Errorf("got[0] = %+v", got[0])
	}
}

func TestDecodeEducation(t *testing.T) {
	got := DecodeEducation("BS Computer Science | MIT | 2005 | 2009")
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Degree != "BS Computer Science" || got[0].School != "MIT" || got[0].StartYear != 2005 || got[0].EndYear != 2009 {
		t.Errorf("got[0] = %+v", got[0])
	}
}

func TestDecodeEducation_NonNumericYear(t *testing.T) {
	got := DecodeEducation("BS | MIT | not-a-year | also-not-a-year")
	if len(got) != 1 || got[0].StartYear != 0 || got[0].EndYear != 0 {
		t.Errorf("non-numeric years should decode to 0, got %+v", got)
	}
}

func TestDecodeFeaturedProjects(t *testing.T) {
	got := DecodeFeaturedProjects("Fishing Game | A canvas game | Play=/fishing-game; Repo=https://github.com/x\nNo Links Project | Desc |")
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Name != "Fishing Game" || len(got[0].Links) != 2 || got[0].Links[0].Label != "Play" || got[0].Links[0].Href != "/fishing-game" {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].Name != "No Links Project" || len(got[1].Links) != 0 {
		t.Errorf("got[1] = %+v", got[1])
	}
}

func TestDecodeStats(t *testing.T) {
	got := DecodeStats("18+ | years\n40+ | projects")
	if len(got) != 2 || got[0].Num != "18+" || got[0].Label != "years" {
		t.Errorf("got = %+v", got)
	}
}

func TestDecodeSubprojects(t *testing.T) {
	got := DecodeSubprojects("Barclays | PayPal | Payments integration | Built X; Shipped Y\nInternal Tool | | No client tag |")
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Heading != "Barclays" || got[0].ClientTag == nil || *got[0].ClientTag != "PayPal" || len(got[0].Bullets) != 2 {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].ClientTag != nil {
		t.Errorf("blank client tag should decode to nil, got %q", *got[1].ClientTag)
	}
}
