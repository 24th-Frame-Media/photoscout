import type {
  DroneEvidence,
  DroneEvidenceSource,
  DroneSeverity,
  DroneAssessmentResult,
} from './types.js';
import type { OpenAipAirspace, OpenAipAirport } from '../providers/openaip.js';

export interface DroneAssessmentInput {
  evidence?: DroneEvidence[];
  notChecked?: DroneEvidence[];
  pilotChecklist?: DroneEvidence[];
  stale?: boolean;
  now?: Date | string;
}

const SEVERITY_PRECEDENCE: Record<DroneSeverity, number> = {
  restriction: 1,
  caution: 2,
  not_checked: 3,
  pilot_responsibility: 4,
  info: 5,
};

export function createDefaultNotCheckedGates(): DroneEvidence[] {
  return [
    {
      id: 'gate-notam',
      category: 'notam',
      severity: 'not_checked',
      authority: 'unknown',
      title: 'NOTAMs',
      explanation:
        'Not checked — obtain current official aviation notices and temporary flight restrictions before flight.',
      source: { name: 'Airservices Australia / NAIPS' },
      userAction: 'Review official NAIPS / NOTAM briefing for tactical airspace activations.',
    },
    {
      id: 'gate-emergency',
      category: 'emergency',
      severity: 'not_checked',
      authority: 'unknown',
      title: 'Non-fire emergency operations',
      explanation:
        'Not checked — emergency operations (police, search and rescue, disaster response) may be underway; confirm with local sources.',
      source: { name: 'State Emergency Services' },
      userAction: 'Check local emergency broadcaster and do not operate near active emergency scenes.',
    },
  ];
}

export function createDefaultPilotChecklist(): DroneEvidence[] {
  return [
    {
      id: 'checklist-vlos',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-073',
      title: 'Visual line of sight (VLOS)',
      explanation:
        'The remote pilot must maintain direct visual contact with the RPA without visual aids other than corrective lenses.',
      source: { name: 'CASR 101.073' },
      userAction: 'Maintain direct unaided visual contact with aircraft throughout flight.',
    },
    {
      id: 'checklist-max-height',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-085',
      title: 'Maximum height (400 ft AGL / 120 m)',
      explanation:
        'Standard RPA operations must remain at or below 400 ft (120 m) above ground level.',
      source: { name: 'CASR 101.085' },
      userAction: 'Plan flight ceiling strictly at or below 400 ft (120 m) above ground level.',
    },
    {
      id: 'checklist-separation',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-245',
      title: '30 m separation from uninvolved people',
      explanation:
        'The remote pilot must maintain at least 30 metres horizontal separation from people not directly involved.',
      source: { name: 'CASR 101.245' },
      userAction: 'Establish and monitor minimum 30 m horizontal perimeter from uninvolved bystanders.',
    },
    {
      id: 'checklist-populous',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-245',
      title: 'Populous area evaluation',
      explanation:
        'Do not operate over populous areas where equipment failure could endanger persons or property.',
      source: { name: 'CASR 101.245, 101.025' },
      userAction: 'Conduct on-site evaluation of ground hazards, population density, and contingency landing paths.',
    },
    {
      id: 'checklist-hazard',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-055',
      title: 'Hazardous operation prevention',
      explanation:
        'An operation must not be conducted in a way that creates a hazard to other aircraft, persons, or property.',
      source: { name: 'CASR 101.055' },
      userAction: 'Review flight plan to ensure no hazard is created to aircraft, persons, or property.',
    },
    {
      id: 'checklist-landowner',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'product_policy',
      title: 'Landowner and site access',
      explanation:
        'Aviation rules do not grant property access; take-off and landing requires landowner/occupier permission.',
      source: { name: 'PhotoScout Pilot Checklist' },
      userAction: 'Obtain launch and recovery permission from landowner or managing authority.',
    },
    {
      id: 'checklist-weather',
      category: 'weather',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-095',
      title: 'Daylight visual meteorological conditions',
      explanation:
        'Standard operations must be in daylight and visual meteorological conditions, remaining clear of cloud.',
      source: { name: 'CASR 101.095' },
      userAction: 'Confirm daylight conditions, sufficient visibility, and separation from clouds.',
    },
  ];
}

export function airspaceToEvidence(
  airspace: OpenAipAirspace,
  source: DroneEvidenceSource
): DroneEvidence {
  const typeName = (airspace.typeName || '').toUpperCase();
  const isRestriction = typeName === 'RESTRICTED' || typeName === 'PROHIBITED';

  if (isRestriction) {
    return {
      id: `airspace-${airspace.id}`,
      category: 'airspace',
      severity: 'restriction',
      authority: 'legislation',
      ruleId: 'casr-101-065',
      title: `${typeName} Airspace: ${airspace.name}`,
      explanation: `OpenAIP mapped ${typeName.toLowerCase()} airspace. Verify current status and operating hours with official aviation publications before planning flight.`,
      geometry: airspace.geometry,
      source,
      userAction:
        'Verify current status with official aviation publications and obtain controlling authority permission if required.',
    };
  }

  return {
    id: `airspace-${airspace.id}`,
    category: 'airspace',
    severity: 'caution',
    authority: 'provider_context',
    ruleId: 'casr-101-065',
    title: `Airspace Caution: ${airspace.name} (${typeName})`,
    explanation: `OpenAIP mapped ${typeName.toLowerCase()} airspace context. Review vertical limits and airspace classification.`,
    geometry: airspace.geometry,
    source,
    userAction: 'Review operating limits and airspace classification before flight.',
  };
}

export function fireIncidentToEvidence(
  incident: {
    id: string;
    title: string;
    category?: string;
    status?: string;
    updated?: string;
    geometry?: GeoJSON.Geometry;
  },
  source: DroneEvidenceSource
): DroneEvidence {
  return {
    id: `fire-${incident.id}`,
    category: 'fire',
    severity: 'restriction',
    authority: 'legislation',
    ruleId: 'casr-101-238-e',
    title: `Active Fire Operation: ${incident.title}`,
    explanation: `Emergency firefighting operation reported by NSW RFS (${incident.status || 'Active'}). CASR 101.238(e) prohibits flight over emergency operations without permission from the person in charge.`,
    geometry: incident.geometry,
    source,
    userAction:
      'Do not launch near active fire emergency operations without permission from the incident controller.',
  };
}

export function populousCautionToEvidence(details: {
  reason?: string;
  indicators?: string[];
}): DroneEvidence {
  return {
    id: 'caution-populous',
    category: 'population',
    severity: 'caution',
    authority: 'regulator_guidance',
    ruleId: 'casr-101-245',
    title: 'Likely populous area / people exposure',
    explanation: `Environmental context indicates potential people or property exposure (${details.reason || 'built-up area'}). Statutory populous-area manual assessment required by pilot.`,
    source: { name: 'PhotoScout Population Heuristic' },
    userAction:
      'Conduct on-site manual assessment of people, populous area risk, and maintain minimum 30 m separation.',
  };
}

export function aerodromeToEvidence(
  airport: OpenAipAirport & { controlledBuffer?: GeoJSON.Geometry },
  source: DroneEvidenceSource
): DroneEvidence {
  if (airport.controlled === true) {
    return {
      id: `airport-${airport.id}`,
      category: 'airport',
      severity: 'caution',
      authority: 'legislation',
      ruleId: 'casr-101-075',
      title: `Controlled aerodrome proximity: ${airport.name}`,
      explanation: `Verified controlled aerodrome (${airport.icaoCode || 'ICAO'}). A 3 NM planning buffer is shown because standard conditions can depend on aircraft category, including the 250 g threshold, and any applicable permission or exemption. Confirm the CASA condition that applies to this operation before flight.`,
      geometry: airport.geometry,
      source,
      userAction: 'Confirm aircraft category/weight, approval status, and applicable controlled-aerodrome conditions before operating within 3 NM.',
    };
  }

  return {
    id: `airport-${airport.id}`,
    category: 'airport',
    severity: 'caution',
    authority: 'provider_context',
    ruleId: 'casr-101-075',
    title: `Aerodrome proximity: ${airport.name}`,
    explanation: `Aerodrome or landing site nearby (${airport.icaoCode || 'advisory context'}). Pilot must check for aircraft movement and approach/departure paths.`,
    geometry: airport.geometry,
    source,
    userAction: 'Check for aerodrome traffic and avoid approach and departure paths.',
  };
}

export function evaluateDroneAssessment(
  input: DroneAssessmentInput
): DroneAssessmentResult {
  const evidenceList = [...(input.evidence ?? [])];
  evidenceList.sort((a, b) => SEVERITY_PRECEDENCE[a.severity] - SEVERITY_PRECEDENCE[b.severity]);

  const notChecked = input.notChecked ?? createDefaultNotCheckedGates();
  const pilotChecklist = input.pilotChecklist ?? createDefaultPilotChecklist();

  const hasRestriction = evidenceList.some((e) => e.severity === 'restriction');
  const hasCaution = evidenceList.some((e) => e.severity === 'caution');

  let overallSeverity: DroneSeverity;
  let summary: string;

  if (hasRestriction) {
    overallSeverity = 'restriction';
    summary =
      'Mapped restriction identified — verify conditions and permissions with controlling authority';
  } else if (hasCaution) {
    overallSeverity = 'caution';
    summary = 'Mapped caution identified — pilot risk assessment required';
  } else if (notChecked.length > 0) {
    overallSeverity = 'not_checked';
    summary = 'No mapped restriction found — pilot checks still required';
  } else {
    overallSeverity = 'info';
    summary = 'No mapped restriction found — pilot checks still required';
  }

  const isStale =
    input.stale === true || evidenceList.some((e) => e.source?.stale === true);

  const evaluatedAt =
    input.now instanceof Date
      ? input.now.toISOString()
      : typeof input.now === 'string'
        ? input.now
        : new Date().toISOString();

  return {
    overallSeverity,
    summary,
    evidence: evidenceList,
    notChecked,
    pilotChecklist,
    stale: isStale,
    evaluatedAt,
  };
}
