-- Bus Stop Finder's reference data (docs/features/bus-stop-finder.md's Data
-- Model): local copies of LTA DataMall's BusStops and BusRoutes datasets,
-- replaced wholesale by the nightly sync. Nothing visitor-specific is
-- stored here — the feature keeps no per-visitor state at all.
--
-- The CHECK constraints are a backstop for the sync's own row validation
-- (internal/service), not the primary validation layer: a malformed or
-- tampered LTA response should be filtered before it ever reaches these
-- tables, and anything that slips through fails the whole transaction
-- rather than landing.
--
-- bus_routes.bus_stop_code deliberately has no FK to bus_stops: LTA's
-- BusRoutes can reference stops that BusStops doesn't list.

-- +goose Up
CREATE TABLE bus_stops (
    code        CHAR(5) PRIMARY KEY,
    road_name   TEXT NOT NULL,
    description TEXT NOT NULL,
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bus_stops_code_format CHECK (code ~ '^[0-9]{5}$'),
    CONSTRAINT bus_stops_road_name_length CHECK (char_length(road_name) <= 120),
    CONSTRAINT bus_stops_description_length CHECK (char_length(description) <= 120),
    CONSTRAINT bus_stops_latitude_range CHECK (latitude BETWEEN 1.15 AND 1.48),
    CONSTRAINT bus_stops_longitude_range CHECK (longitude BETWEEN 103.6 AND 104.1)
);

CREATE INDEX idx_bus_stops_lat_lng ON bus_stops (latitude, longitude);

CREATE TABLE bus_routes (
    service_no    TEXT NOT NULL,
    operator      TEXT NOT NULL,
    direction     SMALLINT NOT NULL,
    stop_sequence INTEGER NOT NULL,
    bus_stop_code CHAR(5) NOT NULL,
    distance_km   DOUBLE PRECISION,
    wd_first      CHAR(4),
    wd_last       CHAR(4),
    sat_first     CHAR(4),
    sat_last      CHAR(4),
    sun_first     CHAR(4),
    sun_last      CHAR(4),
    PRIMARY KEY (service_no, direction, stop_sequence),
    CONSTRAINT bus_routes_service_no_format CHECK (service_no ~ '^[0-9A-Za-z]{1,6}$'),
    CONSTRAINT bus_routes_direction_range CHECK (direction IN (1, 2)),
    CONSTRAINT bus_routes_stop_code_format CHECK (bus_stop_code ~ '^[0-9]{5}$'),
    CONSTRAINT bus_routes_wd_first_format CHECK (wd_first ~ '^[0-2][0-9][0-5][0-9]$'),
    CONSTRAINT bus_routes_wd_last_format CHECK (wd_last ~ '^[0-2][0-9][0-5][0-9]$'),
    CONSTRAINT bus_routes_sat_first_format CHECK (sat_first ~ '^[0-2][0-9][0-5][0-9]$'),
    CONSTRAINT bus_routes_sat_last_format CHECK (sat_last ~ '^[0-2][0-9][0-5][0-9]$'),
    CONSTRAINT bus_routes_sun_first_format CHECK (sun_first ~ '^[0-2][0-9][0-5][0-9]$'),
    CONSTRAINT bus_routes_sun_last_format CHECK (sun_last ~ '^[0-2][0-9][0-5][0-9]$')
);

CREATE INDEX idx_bus_routes_stop_code ON bus_routes (bus_stop_code);

-- +goose Down
DROP INDEX idx_bus_routes_stop_code;
DROP TABLE bus_routes;
DROP INDEX idx_bus_stops_lat_lng;
DROP TABLE bus_stops;
