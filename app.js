// --- Constants and Global Variables ---
mapboxgl.accessToken = 'pk.eyJ1IjoiYXNoZXh6IiwiYSI6ImNtYmVxejlzaTIwcGMyanF1b3hqMzlvNWYifQ.OlK9j2-cugBODhSZIvHNAA'; // USER'S TOKEN INSERTED

// Bounding box from user
const MIN_LAT = 9.727003;
const MAX_LAT = 10.167459;
const MIN_LON = 76.756774;
const MAX_LON = 77.202241;

const initialBounds = [
    [MIN_LON, MIN_LAT], // Southwest coordinates (Longitude, Latitude)
    [MAX_LON, MAX_LAT]  // Northeast coordinates (Longitude, Latitude)
];

const mapCenterLon = (MIN_LON + MAX_LON) / 2;
const mapCenterLat = (MIN_LAT + MAX_LAT) / 2;

// Coordinates for the heatmap images, matching the main bounding box
const heatmapImageCoordinates = [
    [MIN_LON, MAX_LAT], // Top-left
    [MAX_LON, MAX_LAT], // Top-right
    [MAX_LON, MIN_LAT], // Bottom-right
    [MIN_LON, MIN_LAT]  // Bottom-left
];

// Simulation Parameters
const SIMULATION_TIME_STEP_MS = 1000;
const MAX_BURN_DURATION_STEPS = 5;   
const NEIGHBOR_SEARCH_RADIUS_DEGREES = 0.0006; 
const INITIAL_FIRE_STARTS = 3;       
const BOX_HALF_SIZE_DEGREES = 0.0003; 
const MINIMUM_EFFECTIVE_CRITICALITY_FOR_SPREAD = 0.525; 

// Wind Parameters
let globalWindSpeedMps = 0; 
let globalWindDirectionDegrees = null; 
const WIND_API_URL_TEMPLATE = "https://gis.duk.ac.in/dev/weather/service.php?lat={lat}&lon={lon}";
const WIND_EFFECT_SCALER = 0.075; 
const MAX_WIND_BONUS_FACTOR = 0.9;  // Max positive influence
const MAX_UPWIND_PENALTY_FACTOR_RATIO = 1.6; // e.g., upwind penalty is at most 0.5 * MAX_WIND_BONUS_FACTOR

let windParticleAnimationId = null; 

// Custom Wind Particle System
const NUM_WIND_PARTICLES = 200; 
let windParticles = []; 
const WIND_PARTICLE_BASE_SPEED_FACTOR = 0.0004; 
const WIND_PARTICLE_TRAIL_LENGTH_SCALE = 8; 
const PARTICLE_MAX_LIFE_FRAMES = 1000; 
const PARTICLE_MIN_LIFE_FRAMES = 800;  

// Global state variables
let criticalityPoints = []; 
let criticalityIndex = null; 
let fireSimulationLayerVisible = false;
const fireSourceId = 'fire-simulation-source';
const fireLayerId = 'fire-simulation-layer';

const windParticleSourceId = 'custom-wind-particle-source'; 
const windParticleLayerId = 'custom-wind-particle-layer';   
let windParticlesLayerVisible = false; 

let simulationInterval = null;
let currentSimulationTimeStep = 0;
let debugParticleLogging = true; 

// Heatmap layer configurations
const heatmapLayers = {
    'heatmap-elev-layer': { name: 'Elevation', url: 'images/heatmap_ELEV.png', coordinates: heatmapImageCoordinates, loaded: false, sourceId: 'heatmap-elev-source' },
    'heatmap-k-layer': { name: 'Criticality (K)', url: 'images/heatmap_K.png', coordinates: heatmapImageCoordinates, loaded: false, sourceId: 'heatmap-k-source' },
    'heatmap-lst-layer': { name: 'Land Surface Temp.', url: 'images/heatmap_LST.png', coordinates: heatmapImageCoordinates, loaded: false, sourceId: 'heatmap-lst-source' },
    'heatmap-ndvi-layer': { name: 'NDVI', url: 'images/heatmap_NDVI.png', coordinates: heatmapImageCoordinates, loaded: false, sourceId: 'heatmap-ndvi-source' },
    'heatmap-smi-layer': { name: 'Soil Moisture', url: 'images/heatmap_SMI.png', coordinates: heatmapImageCoordinates, loaded: false, sourceId: 'heatmap-smi-source' },
};

// --- Mapbox Initialization ---
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/outdoors-v12', 
});

map.on('load', async () => { 
    console.log("Map loaded.");
    map.fitBounds(initialBounds, { padding: 40 });

    loadStaticHeatmapOverlays();
    await loadCriticalityDataAndSetupSimulation(); 
    setupCustomWindParticleLayer(); 
    setupUIControls();
});

map.on('error', (e) => {
    console.error("Mapbox GL error:", e.error ? e.error.message : e); 
    if (e.error && e.error.message && e.error.message.includes("Failed to fetch") && e.error.message.includes("images/")) {
        console.error("This Mapbox error might be related to a failure to load a heatmap image. Check image paths and ensure the server can find them. Also verify filenames (e.g., .png vs .jpg).");
    } else if (e.error && e.error.message && e.error.message.includes("Failed to fetch")) {
         alert("Map tiles or other resources failed to load. Check your internet connection and Mapbox access token.");
    }
});

// --- Wind Data Functions (for SIMULATION and VISUALIZATION) ---
async function fetchSimulationWindData() { 
    const url = WIND_API_URL_TEMPLATE.replace("{lat}", mapCenterLat.toFixed(6)).replace("{lon}", mapCenterLon.toFixed(6));
    console.log("Fetching SIMULATION wind data from:", url);
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        if (data && data.wind) {
            globalWindSpeedMps = parseFloat(data.wind.speed) || 0; 
            globalWindDirectionDegrees = parseFloat(data.wind.deg);  
            if (isNaN(globalWindDirectionDegrees)) globalWindDirectionDegrees = null;
            console.log(`SIMULATION Global wind updated: Speed ${globalWindSpeedMps.toFixed(1)} m/s, Direction FROM ${globalWindDirectionDegrees !== null ? globalWindDirectionDegrees.toFixed(0) + '°' : 'N/A'}`);
            
            if (windParticles.length === 0 || (data.wind.speed && data.wind.deg)) {
                 initializeWindParticles();
            }
        } else {
            console.warn("SIMULATION Wind data (data.wind) not found in API response or response structure is unexpected.");
            globalWindSpeedMps = 0; globalWindDirectionDegrees = null;
            if (windParticles.length === 0) initializeWindParticles();
        }
    } catch (error) {
        console.error("Failed to fetch SIMULATION global wind data:", error);
        alert("Could not fetch wind data for simulation. Simulation will proceed without API wind effects. Error: " + error.message);
        globalWindSpeedMps = 0; globalWindDirectionDegrees = null;
        if (windParticles.length === 0) initializeWindParticles(); 
    }
    updateWindParticleVisualization();
}

// --- Custom Wind Particle VISUALIZATION Layer Setup ---
function setupCustomWindParticleLayer() { 
    if (!map.getSource(windParticleSourceId)) {
        map.addSource(windParticleSourceId, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    if (!map.getLayer(windParticleLayerId)) {
        map.addLayer({
            id: windParticleLayerId,
            type: 'line', 
            source: windParticleSourceId,
            layout: {
                'visibility': 'none',
                'line-cap': 'round', 
                'line-join': 'round'
            },
            paint: {
                'line-color': '#FFFFFF', 
                'line-width': ['interpolate', ['linear'], ['get', 'opacity'], 0, 0.5, 1, 1.5], 
                'line-opacity': ['get', 'opacity'] 
            }
        });
    }
    console.log("Custom wind particle (line) layer setup complete.");
}

function initializeWindParticles() {
    windParticles = [];
    for (let i = 0; i < NUM_WIND_PARTICLES; i++) {
        resetParticle(i, true); 
    }
    console.log(`Initialized/Reset ${windParticles.length} wind particles.`);
}

function resetParticle(index, initialPlacement = false) {
    const particle = windParticles[index] || {}; 
    particle.id = index;
    
    let startLng, startLat;

    if (initialPlacement || globalWindSpeedMps === 0 || globalWindDirectionDegrees === null) {
        startLng = MIN_LON + Math.random() * (MAX_LON - MIN_LON);
        startLat = MIN_LAT + Math.random() * (MAX_LAT - MIN_LAT);
    } else {
        const randomOffset = Math.random(); 
        if (globalWindDirectionDegrees >= 315 || globalWindDirectionDegrees < 45) { 
            startLat = MAX_LAT - 0.001; 
            startLng = MIN_LON + randomOffset * (MAX_LON - MIN_LON);
        } else if (globalWindDirectionDegrees >= 45 && globalWindDirectionDegrees < 135) { 
            startLng = MAX_LON - 0.001; 
            startLat = MIN_LAT + randomOffset * (MAX_LAT - MIN_LAT);
        } else if (globalWindDirectionDegrees >= 135 && globalWindDirectionDegrees < 225) { 
            startLat = MIN_LAT + 0.001; 
            startLng = MIN_LON + randomOffset * (MAX_LON - MIN_LON);
        } else { 
            startLng = MIN_LON + 0.001; 
            startLat = MIN_LAT + randomOffset * (MAX_LAT - MIN_LAT);
        }
    }
    particle.lng = startLng;
    particle.lat = startLat;
    particle.prevLng = startLng; 
    particle.prevLat = startLat;
    particle.life = 0; 
    particle.maxLife = PARTICLE_MIN_LIFE_FRAMES + Math.random() * (PARTICLE_MAX_LIFE_FRAMES - PARTICLE_MIN_LIFE_FRAMES);
    particle.speedFactor = WIND_PARTICLE_BASE_SPEED_FACTOR * (0.6 + Math.random() * 0.8); 
    particle.opacity = 1.0; 
    windParticles[index] = particle;
}


function animateWindParticles() {
    if (!windParticlesLayerVisible || !map.getLayer(windParticleLayerId)) { 
        if (windParticleAnimationId) {
            cancelAnimationFrame(windParticleAnimationId);
            windParticleAnimationId = null;
        }
        return;
    }

    let particlesUpdated = false;
    if (globalWindSpeedMps > 0 && globalWindDirectionDegrees !== null) {
        const windBlowsTowardMathAngleRad = ((270 - globalWindDirectionDegrees + 360) % 360) * Math.PI / 180;
        
        windParticles.forEach((p, index) => {
            p.prevLng = p.lng;
            p.prevLat = p.lat;

            const dLng = globalWindSpeedMps * p.speedFactor * Math.cos(windBlowsTowardMathAngleRad);
            const dLat = globalWindSpeedMps * p.speedFactor * Math.sin(windBlowsTowardMathAngleRad);

            p.lng += dLng;
            p.lat += dLat;
            p.life++;
            p.opacity = Math.max(0, 1 - (p.life / p.maxLife));
            particlesUpdated = true;

            if (index === 0 && debugParticleLogging && currentSimulationTimeStep % 60 === 0) { 
                console.log(`P0: life=${p.life}/${p.maxLife}, pos=(${p.lng.toFixed(5)}, ${p.lat.toFixed(5)}), dLng=${dLng.toExponential(2)}, dLat=${dLat.toExponential(2)}, opac=${p.opacity.toFixed(2)} Wind: ${globalWindSpeedMps.toFixed(1)}m/s @ ${globalWindDirectionDegrees}°`);
            }

            const buffer = 0.05 * (MAX_LON - MIN_LON); 
            if (p.life > p.maxLife || p.lng > MAX_LON + buffer || p.lng < MIN_LON - buffer || p.lat > MAX_LAT + buffer || p.lat < MIN_LAT - buffer) {
                resetParticle(index);
            }
        });
    } else {
        windParticles.forEach((p, index) => {
            p.prevLng = p.lng; 
            p.prevLat = p.lat;
            p.life++;
            p.opacity = Math.max(0, 1 - (p.life / p.maxLife));
             if (p.life > p.maxLife) {
                resetParticle(index, true); 
            }
        });
        particlesUpdated = true; 
    }

    if(particlesUpdated){
        updateWindParticleVisualization(); 
    }
    
    windParticleAnimationId = requestAnimationFrame(animateWindParticles);
}

function updateWindParticleVisualization() { 
    const source = map.getSource(windParticleSourceId);
    if (!source || !map.isStyleLoaded()) { 
        return; 
    }
     if (windParticles.length === 0 && NUM_WIND_PARTICLES > 0 && map.getSource(windParticleSourceId)) { 
        // This case is mostly handled by fetchSimulationWindData or the toggle button.
        // Avoid initializing here if it might conflict with an ongoing fetch/initialization.
    }

    const features = windParticles.map(p => {
        let trailStartLng = p.lng;
        let trailStartLat = p.lat;

        if (globalWindSpeedMps > 0 && globalWindDirectionDegrees !== null && p.opacity > 0) { 
            const windBlowsTowardMathAngleRad = ((270 - globalWindDirectionDegrees + 360) % 360) * Math.PI / 180;
            const dLngPerFrame = globalWindSpeedMps * p.speedFactor * Math.cos(windBlowsTowardMathAngleRad);
            const dLatPerFrame = globalWindSpeedMps * p.speedFactor * Math.sin(windBlowsTowardMathAngleRad);
            
            trailStartLng = p.lng - dLngPerFrame * WIND_PARTICLE_TRAIL_LENGTH_SCALE;
            trailStartLat = p.lat - dLatPerFrame * WIND_PARTICLE_TRAIL_LENGTH_SCALE;
        } else {
            trailStartLng = p.lng; 
            trailStartLat = p.lat;
        }

        return {
            type: 'Feature',
            geometry: { 
                type: 'LineString', 
                coordinates: [ [trailStartLng, trailStartLat], [p.lng, p.lat] ] 
            },
            properties: { 
                id: p.id,
                opacity: p.opacity 
            }
        };
    });
    
    try {
        if (map.getSource(windParticleSourceId)) { 
             source.setData({ type: 'FeatureCollection', features: features });
        }
    } catch (error) {
        console.error("Error setting data on wind particle source:", error);
    }
}


// --- Static Heatmap Overlay Functions ---
function loadStaticHeatmapOverlays() {
    console.log("Loading static heatmap overlays...");
    for (const layerId in heatmapLayers) {
        const layerConfig = heatmapLayers[layerId];
        try {
            if (!map.getSource(layerConfig.sourceId)) {
                map.addSource(layerConfig.sourceId, { type: 'image', url: layerConfig.url, coordinates: layerConfig.coordinates });
            }
            if (!map.getLayer(layerId)) {
                map.addLayer({ id: layerId, type: 'raster', source: layerConfig.sourceId, paint: { 'raster-opacity': 0.65, 'raster-fade-duration': 0 }, layout: { 'visibility': 'none' } });
            }
            layerConfig.loaded = true; 
            console.log(`${layerConfig.name} heatmap layer setup initiated for URL: ${layerConfig.url}`);
        } catch (error) {
            console.error(`Error setting up source/layer for ${layerConfig.name} (${layerConfig.url}):`, error);
        }
    }
}

// --- Criticality Data and Simulation Setup Functions ---
async function loadCriticalityDataAndSetupSimulation() { 
    console.log("Loading criticality data from 'interpolated_criticality.csv'...");
    return new Promise((resolve, reject) => { 
        Papa.parse('interpolated_criticality.csv', { 
            download: true, 
            header: true, 
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: async function(results) { 
                if (results.errors.length > 0) {
                    console.error("Errors parsing interpolated_criticality.csv:", results.errors);
                    alert("Error parsing interpolated_criticality.csv. Check console for details. Simulation may not work correctly.");
                    reject(new Error("CSV parsing error")); return;
                }
                if (!results.data || results.data.length === 0) {
                    console.error("No data loaded from interpolated_criticality.csv. Check file content and path.");
                    alert("No data found in interpolated_criticality.csv. Please ensure the file is correct and contains data.");
                    reject(new Error("No data in CSV")); return;
                }

                const latField = 'lat';
                const lonField = 'long';
                const kField = 'K';

                const firstRow = results.data[0];
                if (!firstRow.hasOwnProperty(latField)) console.warn(`Expected header '${latField}' not found.`);
                if (!firstRow.hasOwnProperty(lonField)) console.warn(`Expected header '${lonField}' not found.`);
                if (!firstRow.hasOwnProperty(kField)) console.warn(`Expected header '${kField}' not found.`);

                criticalityPoints = results.data.map((row, index) => {
                    const point = {
                        id: index, lat: row[latField], lng: row[lonField], K: row[kField],      
                        isBurning: false, burnTimeRemaining: 0, isBurntOut: false
                    };
                    if (typeof point.lng !== 'number' || typeof point.lat !== 'number' || typeof point.K !== 'number') {
                        console.warn(`Invalid data type in row ${index + 1}:`, row); return null; 
                    }
                    point.K = Math.max(0, Math.min(1, point.K)); 
                    return point;
                }).filter(p => p !== null); 

                if (criticalityPoints.length === 0) {
                    console.error("No valid criticality points after processing."); alert("No valid data points. Simulation cannot run."); 
                    reject(new Error("No valid criticality points")); return;
                }
                console.log(`Loaded ${criticalityPoints.length} valid criticality points.`);

                try {
                    criticalityIndex = new KDBush(criticalityPoints, p => p.lng, p => p.lat);
                    console.log("Spatial index (kdbush) created successfully.");
                } catch (kdbushError) {
                    console.error("Error creating KDBush spatial index:", kdbushError); alert("Spatial index failed. Check console."); criticalityIndex = null; 
                    reject(kdbushError); return;
                }

                if (!map.getSource(fireSourceId)) {
                    map.addSource(fireSourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                }
                if (!map.getLayer(fireLayerId)) {
                    map.addLayer({
                        id: fireLayerId, type: 'fill', source: fireSourceId,
                        paint: { 'fill-color': [ 'match', ['get', 'status'], 'burning', '#FF4500', 'burnt_out', '#505050', '#000000'], 'fill-opacity': 0.4, 'fill-outline-color': '#FFA07A' },
                        layout: { 'visibility': 'none' }
                    });
                }
                console.log("Fire simulation layer and source setup complete.");
                
                await fetchSimulationWindData(); 
                resolve(); 
            },
            error: function(err) {
                console.error("Error loading/parsing CSV:", err); alert(`Failed to load CSV: ${err.message}.`);
                reject(err);
            }
        });
    });
}

// --- Fire Simulation Core Logic Functions ---
function startFireAtPoint(pointObject) {
    if (pointObject && !pointObject.isBurning && !pointObject.isBurntOut) {
        pointObject.isBurning = true; pointObject.burnTimeRemaining = MAX_BURN_DURATION_STEPS;
        console.log(`Initial fire: ${pointObject.lng.toFixed(4)}, ${pointObject.lat.toFixed(4)}`);
    }
}

function runFireSimulationStep() {
    if (!criticalityIndex) { console.warn("KDBush index N/A."); stopSimulation(); alert("Sim error: Spatial index N/A."); return; }
    currentSimulationTimeStep++;
    let newFiresThisStep = []; 
    let pointsChangedState = false;

    criticalityPoints.forEach(point => {
        if (point.isBurning) {
            point.burnTimeRemaining--; pointsChangedState = true;
            if (point.burnTimeRemaining <= 0) {
                point.isBurning = false; point.isBurntOut = true; 
            } else {
                const neighborIndices = criticalityIndex.within(point.lng, point.lat, NEIGHBOR_SEARCH_RADIUS_DEGREES);
                neighborIndices.forEach(index => {
                    const actualNeighbor = criticalityPoints[index]; 
                    if (actualNeighbor && actualNeighbor.id !== point.id && !actualNeighbor.isBurning && !actualNeighbor.isBurntOut) {
                        
                        let baseEffectiveCriticality = actualNeighbor.K * Math.max(0.1, 1 - (currentSimulationTimeStep * 0.003)); 
                        let finalEffectiveCriticality = baseEffectiveCriticality; // Initialize with base

                        // Apply MINIMUM_EFFECTIVE_CRITICALITY_FOR_SPREAD as the first gate
                        if (baseEffectiveCriticality < MINIMUM_EFFECTIVE_CRITICALITY_FOR_SPREAD) {
                            finalEffectiveCriticality = 0; // Not inherently spreadable enough
                        } else {
                            // If inherently spreadable, then apply wind influence
                            if (globalWindSpeedMps > 0 && globalWindDirectionDegrees !== null) {
                                const dx = actualNeighbor.lng - point.lng; 
                                const dy = actualNeighbor.lat - point.lat; 
                                const spreadDistSq = dx*dx + dy*dy;

                                if (spreadDistSq > 0) { 
                                    const spreadDist = Math.sqrt(spreadDistSq);
                                    const windBlowsTowardMathAngleRad = ((270 - globalWindDirectionDegrees + 360) % 360) * Math.PI / 180;
                                    const cosAngleDiff = (dx * Math.cos(windBlowsTowardMathAngleRad) + dy * Math.sin(windBlowsTowardMathAngleRad)) / spreadDist;
                                    
                                    const rawWindInfluence = cosAngleDiff * globalWindSpeedMps * WIND_EFFECT_SCALER;
                                    let cappedWindInfluence;

                                    if (rawWindInfluence >= 0) { // Downwind or no strong opposing component
                                        cappedWindInfluence = Math.min(MAX_WIND_BONUS_FACTOR, rawWindInfluence);
                                    } else { // Upwind
                                        // Upwind penalty is reduced by MAX_UPWIND_PENALTY_FACTOR_RATIO
                                        const maxPenalty = MAX_WIND_BONUS_FACTOR * MAX_UPWIND_PENALTY_FACTOR_RATIO;
                                        cappedWindInfluence = Math.max(-maxPenalty, rawWindInfluence);
                                    }
                                    
                                    finalEffectiveCriticality = baseEffectiveCriticality + cappedWindInfluence; 
                                    finalEffectiveCriticality = Math.max(0, Math.min(1, finalEffectiveCriticality)); 
                                }
                            }
                        }
                        // The final check uses the wind-modified (or base, if no wind/not spreadable enough initially) criticality
                        if (finalEffectiveCriticality > 0 && Math.random() < finalEffectiveCriticality) { // Check final > 0 before random
                            if (!newFiresThisStep.some(p => p.id === actualNeighbor.id)) newFiresThisStep.push(actualNeighbor);
                        }
                    }
                });
            }
        }
    });

    if (newFiresThisStep.length > 0) {
        pointsChangedState = true;
        newFiresThisStep.forEach(pointToIgnite => {
            if (!pointToIgnite.isBurning && !pointToIgnite.isBurntOut) { 
                pointToIgnite.isBurning = true; pointToIgnite.burnTimeRemaining = MAX_BURN_DURATION_STEPS;
            }
        });
    }

    if (pointsChangedState) updateFireVisualization();

    if (!criticalityPoints.some(p => p.isBurning) && currentSimulationTimeStep > 0 && newFiresThisStep.length === 0) {
        stopSimulation(); console.log("Sim auto-stopped: No active fires.");
        const btn = document.getElementById('toggleFireSimButton'); if (btn) btn.textContent = 'Start Fire Simulation';
    }
}

function updateFireVisualization() {
    const features = criticalityPoints.filter(p => p.isBurning || p.isBurntOut).map(p => {
        const halfSize = BOX_HALF_SIZE_DEGREES;
        const minLng = p.lng - halfSize, maxLng = p.lng + halfSize, minLat = p.lat - halfSize, maxLat = p.lat + halfSize;
        return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[ [minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat], [minLng, maxLat] ]] },
            properties: { status: p.isBurning ? 'burning' : 'burnt_out', K: p.K, id: p.id }
        };
    });
    const source = map.getSource(fireSourceId);
    if (source) source.setData({ type: 'FeatureCollection', features: features });
}

function startSimulation() {
    if (simulationInterval) return; 
    if (criticalityPoints.length === 0) { alert("Sim error: No criticality data."); return; }
    if (!criticalityIndex) { alert("Sim error: Spatial index N/A."); return; }

    console.log("Starting fire simulation...");
    currentSimulationTimeStep = 0;
    criticalityPoints.forEach(p => { p.isBurning = false; p.isBurntOut = false; p.burnTimeRemaining = 0; });

    let firesStarted = 0;
    const shuffledPoints = [...criticalityPoints].sort(() => 0.5 - Math.random()); 
    for (let i = 0; i < Math.min(INITIAL_FIRE_STARTS, shuffledPoints.length); i++) {
        startFireAtPoint(shuffledPoints[i]); firesStarted++;
    }
    if (firesStarted === 0 && criticalityPoints.length > 0) startFireAtPoint(criticalityPoints[0]);

    updateFireVisualization(); 
    simulationInterval = setInterval(runFireSimulationStep, SIMULATION_TIME_STEP_MS);
}

function stopSimulation() {
    if (simulationInterval) { clearInterval(simulationInterval); simulationInterval = null; console.log("Sim stopped."); }
    if (windParticleAnimationId) { cancelAnimationFrame(windParticleAnimationId); windParticleAnimationId = null;}
}

// --- UI Control Setup Functions ---
function setupUIControls() {
    const fireButton = document.getElementById('toggleFireSimButton');
    if (fireButton) {
        fireButton.addEventListener('click', () => {
            fireSimulationLayerVisible = !fireSimulationLayerVisible;
            if (fireSimulationLayerVisible) {
                if (!map.getLayer(fireLayerId) || !map.getSource(fireSourceId)) { 
                    alert("Sim components not ready. Wait for data load."); fireSimulationLayerVisible = false; return;
                }
                map.setLayoutProperty(fireLayerId, 'visibility', 'visible');
                fireButton.textContent = 'Stop & Hide Fire Sim';
                startSimulation();
            } else {
                if (map.getLayer(fireLayerId)) map.setLayoutProperty(fireLayerId, 'visibility', 'none');
                fireButton.textContent = 'Start Fire Simulation';
                stopSimulation();
            }
        });
    } else console.warn("toggleFireSimButton N/A.");

    const windButton = document.getElementById('toggleWindButton'); 
    if (windButton) {
        windButton.addEventListener('click', () => {
            windParticlesLayerVisible = !windParticlesLayerVisible; 
            if (map.getLayer(windParticleLayerId)) {
                 map.setLayoutProperty(windParticleLayerId, 'visibility', windParticlesLayerVisible ? 'visible' : 'none');
                 windButton.textContent = windParticlesLayerVisible ? 'Hide Wind Streaks' : 'Show Wind Streaks';
                 if (windParticlesLayerVisible) {
                    if (windParticles.length === 0) initializeWindParticles(); 
                    if (globalWindSpeedMps === 0 && globalWindDirectionDegrees === null) { 
                        fetchSimulationWindData(); 
                    }
                    if (!windParticleAnimationId) {
                        animateWindParticles(); 
                    }
                 } else {
                    if (windParticleAnimationId) {
                        cancelAnimationFrame(windParticleAnimationId);
                        windParticleAnimationId = null;
                    }
                 }
            } else {
                alert("Wind streak layer not ready. It might be loading or an error occurred.");
                windParticlesLayerVisible = false; 
            }
        });
    } else console.warn("toggleWindButton N/A. Ensure your HTML has a button with this ID.");


    const heatmapCheckboxesContainer = document.getElementById('heatmapCheckboxes');
    if (heatmapCheckboxesContainer) {
        for (const layerId in heatmapLayers) {
            const layerConfig = heatmapLayers[layerId];
            const checkboxId = `toggle-${layerConfig.sourceId}`;
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox'; checkbox.id = checkboxId; checkbox.dataset.layerId = layerId; 
            label.appendChild(checkbox); label.appendChild(document.createTextNode(` ${layerConfig.name}`));
            heatmapCheckboxesContainer.appendChild(label); heatmapCheckboxesContainer.appendChild(document.createElement('br'));

            checkbox.addEventListener('change', (e) => {
                const targetLayerId = e.target.dataset.layerId;
                const targetLayerConfig = heatmapLayers[targetLayerId];
                if (targetLayerConfig && map.getLayer(targetLayerId) && map.getSource(targetLayerConfig.sourceId)) { 
                    map.setLayoutProperty(targetLayerId, 'visibility', e.target.checked ? 'visible' : 'none');
                } else if (targetLayerConfig) { 
                    alert(`${targetLayerConfig.name} heatmap N/A. Check console.`); e.target.checked = false; 
                } else console.warn(`Config for layerId ${targetLayerId} N/A.`);
            });
        }
    } else console.warn("heatmapCheckboxes container N/A.");
}

// Helper for debugging
function logMapState() {
    if (map.isStyleLoaded()) {
        console.log("Sources:", JSON.parse(JSON.stringify(map.getStyle().sources))); 
        console.log("Layers:", map.getStyle().layers.map(l => l.id));
    } else console.log("Map style not loaded for logging.");
}
