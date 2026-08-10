-- Schema and seed data live in one migration, not two: this is a
-- single-owner site with one canonical seed and no per-environment
-- variance, so a second file would only add migration surface. See
-- docs/features/resume.md's Data Model.

-- +goose Up
CREATE TABLE resume_profile (
    id                 BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
    role_title         TEXT NOT NULL,
    tenure_label       TEXT NOT NULL,
    location_label     TEXT NOT NULL,
    contact_links      JSONB NOT NULL, -- [{label, href, icon}], ordered
    summary_paragraphs JSONB NOT NULL, -- ["text with **bold** spans", ...], ordered
    stats              JSONB NOT NULL, -- [{num, label}], ordered
    skill_groups       JSONB NOT NULL, -- [{name, skills: [string]}], ordered
    education          JSONB NOT NULL, -- [{degree, school, start_year, end_year}], ordered
    featured_projects  JSONB NOT NULL, -- [{name, description, links: [{label, href}]}], ordered
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resume_roles (
    id           BIGSERIAL PRIMARY KEY,
    title        TEXT NOT NULL,
    company      TEXT NOT NULL,
    location     TEXT,
    start_date   DATE NOT NULL,
    end_date     DATE,                        -- NULL = current/present
    blurb        TEXT,
    bullets      JSONB NOT NULL DEFAULT '[]', -- [string], ordered
    subprojects  JSONB NOT NULL DEFAULT '[]', -- [{heading, client_tag, blurb, bullets: [string]}], ordered
    sort_order   INTEGER NOT NULL,            -- authoritative display order
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO resume_profile (
    id, role_title, tenure_label, location_label,
    contact_links, summary_paragraphs, stats, skill_groups, education, featured_projects
) VALUES (
    1,
    'Principal / Staff Software Engineer',
    '18+ years · Architecture & Technical Leadership',
    'Singapore',
    $$[
        {"label": "+65 8233 8537", "href": "tel:+6582338537", "icon": "phone"},
        {"label": "vincent.megia@gmail.com", "href": "mailto:vincent.megia@gmail.com", "icon": "mail"},
        {"label": "vincentmegia.onrender.com", "href": "https://vincentmegia.onrender.com", "icon": "globe"},
        {"label": "github.com/vincentmegia", "href": "https://github.com/vincentmegia", "icon": "branch"},
        {"label": "linkedin.com/in/vincent-megia", "href": "https://sg.linkedin.com/in/vincent-megia", "icon": "network"},
        {"label": "leetcode.com/iamstupendous", "href": "https://leetcode.com/iamstupendous/", "icon": "bars"}
    ]$$::jsonb,
    $$[
        "Principal Software Engineer with **18+ years** of experience designing, building, and modernizing large-scale enterprise platforms across telecommunications, fintech, payments, and investment banking.",
        "Currently accountable for architecture, technical direction, delivery, and production ownership across **7 critical Singtel platforms** supporting **1M+ prepaid subscribers** and hundreds of thousands of hybrid mobile customers. Experienced in distributed systems, microservices, API architecture, cloud platforms, system integration, and full-stack engineering.",
        "Proven track record leading cross-border engineering teams, influencing architecture and delivery decisions, modernizing engineering practices, and delivering business-critical platforms with measurable customer and operational impact.",
        "Previously delivered payment platforms at **PayPal** and wealth management, trading, settlement, and reporting systems for **Barclays**, combining deep enterprise integration experience with hands-on software engineering."
    ]$$::jsonb,
    $$[
        {"num": "1M+", "label": "Prepaid Subscribers Supported"},
        {"num": "17%", "label": "Traffic Growth · Search Service"},
        {"num": "100%", "label": "Audit Compliance · Doc Services"},
        {"num": "13", "label": "Engineers Led · SG & India"}
    ]$$::jsonb,
    $$[
        {"name": "Architecture & Technical Leadership", "skills": ["Distributed Systems & Microservices Architecture", "Enterprise & Solution Architecture", "API & System Integration", "Platform Modernization", "Technical Strategy & Engineering Governance", "Production Ownership & Reliability", "Cross-functional Stakeholder Leadership", "Engineering Team Leadership"]},
        {"name": "Cloud & Platform Engineering", "skills": ["AWS", "Kubernetes", "Docker", "Redis", "CI/CD & Deployment Automation", "Observability & Production Monitoring"]},
        {"name": "Software Engineering", "skills": ["Java", "Spring Boot", "Spring MVC", "TypeScript", "JavaScript", "React", "React Native", "Angular", "SQL", "REST APIs", "WebSockets", "C#", "WCF", "Hibernate", "Akka"]},
        {"name": "Financial & Enterprise Integration", "skills": ["SWIFT MT502/509/515", "FIX 4.4", "Financial Transaction Processing", "Portfolio & Wealth Management Systems", "Informatica ETL"]}
    ]$$::jsonb,
    $$[
        {"degree": "B.S. Computer Science", "school": "De La Salle University", "start_year": 1998, "end_year": 2002}
    ]$$::jsonb,
    $$[
        {"name": "Personal Site", "description": "Angular front end backed by a REST API.", "links": [{"label": "vincentmegia.onrender.com", "href": "https://vincentmegia.onrender.com"}]},
        {"name": "Puzzle Solver", "description": "ReactJS puzzle-solving application.", "links": [{"label": "puzzle-solver.onrender.com", "href": "https://puzzle-solver.onrender.com"}]},
        {"name": "Pair Me Up!", "description": "Memory-matching mobile game, published on iOS and Android.", "links": [{"label": "iOS", "href": "https://apps.apple.com/us/app/pair-me-up/id6443525441"}, {"label": "Android", "href": "https://play.google.com/store/apps/details?id=com.stupendousware.pairinggame"}]}
    ]$$::jsonb
);

INSERT INTO resume_roles (
    title, company, location, start_date, end_date, blurb, bullets, subprojects, sort_order
) VALUES (
    'Principal Software Engineer / Application Owner',
    'Singtel',
    'Singapore',
    '2021-04-01',
    NULL,
    'Technical owner for 7 critical customer-facing production systems spanning insurance, digital entertainment, subscription management, prepaid and hybrid mobile services, physical SIM/eSIM provisioning, top-up, and remittance platforms.',
    $$[
        "Own architecture, technical direction, delivery, and production lifecycle across 7 critical systems supporting 1M+ prepaid subscribers and hundreds of thousands of hybrid mobile customers",
        "Lead a 13-member engineering team across Singapore and India, overseeing technical delivery, code reviews, engineering practices, and stakeholder coordination",
        "Partner directly with senior business stakeholders, including the Sales Channel Director and Product Owners, translating business requirements into technical architecture and delivery strategies",
        "Directed implementation of the Singtel Search Service, optimizing indexing and caching strategies and increasing traffic by 17% through improved discovery performance",
        "Integrated GovTech KYC systems to automate identity verification and regulatory compliance workflows",
        "Architected Electronic Document Services, achieving 100% audit compliance aligned with financial-grade standards",
        "Designed and developed Java/Spring Boot microservices, integrating internal APIs and AWS services across business-critical platforms",
        "Modernized Jenkins CI/CD pipelines, improving deployment frequency and release reliability",
        "Introduced observability and monitoring improvements to strengthen production support and incident response",
        "Own SIT/UAT technical sign-off across all 7 systems, ensuring production readiness and integration quality",
        "Led React Native modularization initiatives, reducing application complexity and improving maintainability"
    ]$$::jsonb,
    $$[
        {"heading": "Digital Entertainment & Subscription Management — Platform X", "client_tag": null, "blurb": "Technical owner for Singtel's digital entertainment and subscription management platform, including cast.sg, serving as the source of record for the product catalogue.", "bullets": []},
        {"heading": "Heya — Hybrid Mobile Platform", "client_tag": null, "blurb": "Designed and led the backend architecture for Singtel's Heya hybrid mobile application serving 200,000+ subscribers across iOS and Android.", "bullets": []},
        {"heading": "Hi!App — Singtel Prepaid", "client_tag": null, "blurb": "Supported the technical delivery of Singtel's prepaid mobile application serving 1M+ subscribers, including top-up, promotions, and account management.", "bullets": []}
    ]$$::jsonb,
    1
);

INSERT INTO resume_roles (
    title, company, location, start_date, end_date, blurb, bullets, subprojects, sort_order
) VALUES (
    'Senior Software Engineer',
    'Sofgen (IT Consultancy)',
    'Singapore',
    '2010-01-01',
    '2021-02-28',
    'Delivered enterprise financial technology platforms for global banking and payments clients, combining hands-on software engineering with architecture, integration, automation, and production delivery.',
    '[]'::jsonb,
    $$[
        {
            "heading": "Barclays Wealth",
            "client_tag": "Client · Barclays Wealth · Jan 2010 – Dec 2016",
            "blurb": "Delivered trading, portfolio management, settlement, and client-reporting systems for Barclays' private banking division on the Charles River Investment Management platform.",
            "bullets": [
                "Built production WCF services in C# supporting FX forward settlement and portfolio modeling, including Custom Blotter Actions, Back-2-Back FX, and Model Deviation",
                "Developed a comprehensive NUnit test suite integrated with TeamCity CI for the custom component codebase",
                "Led migration of client performance reporting from Actuate to SAP Business Objects",
                "Built a responsive Angular/TypeScript/WebSockets frontend and concurrent Java/Spring/Akka backend delivering performance reports to mass-affluent and high-net-worth clients",
                "Designed and implemented an ETL integration pipeline converting Charles River FIX 4.4 messages to SWIFT XML and subsequently to SWIFT MT502/MT509/MT515, automating a previously manual settlement process",
                "Automated the Informatica deployment workflow, removing a recurring manual release step",
                "Delivered backend integration between Charles River and Vestima's global fund settlement network, supporting order routing, DVP settlement, and safekeeping over SWIFT",
                "Re-engineered the Charles River Anywhere web platform used by private bankers and banking executives"
            ]
        },
        {
            "heading": "PayPal",
            "client_tag": "Client · PayPal · Oct 2020 – Feb 2021",
            "blurb": "Built payment infrastructure supporting PayPal's US QR-code scan-to-pay capabilities.",
            "bullets": [
                "Built the QR Code Gateway API, an orchestration layer for US PayPal QR-code mobile scan-to-pay transactions",
                "Delivered REST API microservices using Spring Boot for transaction processing",
                "Established code-quality gates using Cobertura, PMD, and FindBugs",
                "Built Jenkins and Docker CI/CD pipelines supporting service delivery",
                "Partnered with Product and Project Management to define scope and deliver releases against business timelines"
            ]
        }
    ]$$::jsonb,
    2
);

INSERT INTO resume_roles (
    title, company, location, start_date, end_date, blurb, bullets, subprojects, sort_order
) VALUES (
    'Lead Developer',
    'Tangspac',
    'Singapore',
    '2009-08-01',
    '2010-01-31',
    NULL,
    $$[
        "Led development of an online suitability and trading-restriction platform supporting compliance with SEC Rule 3a4",
        "Gathered requirements directly with a US-based development lead and produced functional and technical specifications",
        "Developed HTML UI prototypes and implemented the application using Java/Spring MVC",
        "Integrated the application with backend systems providing account and asset-class information"
    ]$$::jsonb,
    '[]'::jsonb,
    3
);

INSERT INTO resume_roles (
    title, company, location, start_date, end_date, blurb, bullets, subprojects, sort_order
) VALUES (
    'Software Engineer',
    'Optimum Solutions',
    'Singapore',
    '2007-11-01',
    '2009-03-31',
    NULL,
    $$[
        "Owned a global rule-based Java Windows service deployed across 10 instances, consuming Agora order-management notifications and feeding executed trades to the Clearvision back office",
        "Built the Agora Trade Monitoring Tool, providing traders and support teams with real-time visibility of positions and executions across multiple exchanges",
        "Added TOCOM reconciliation feeds supporting the Japanese market",
        "Served as 2nd-level production escalation for APAC and Europe",
        "Led peer reviews and onboarding for junior engineers"
    ]$$::jsonb,
    '[]'::jsonb,
    4
);

-- +goose Down
DROP TABLE resume_roles;
DROP TABLE resume_profile;
