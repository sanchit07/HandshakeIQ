
import { Person, Meeting } from './types';

export const MOCK_PEOPLE: Person[] = [
  { id: '1', name: 'Alina Petrova', title: 'CEO', company: 'InnovateX', photoUrl: 'https://picsum.photos/id/1027/200/200', email: 'alina.petrova@innovatex.com' },
  { id: '2', name: 'Ben Carter', title: 'Lead Engineer', company: 'TechSolutions', photoUrl: 'https://picsum.photos/id/1005/200/200', email: 'ben.carter@techsolutions.io' },
  { id: '3', name: 'Carla Rodriguez', title: 'Marketing Director', company: 'Future Media', photoUrl: 'https://picsum.photos/id/1011/200/200', email: 'carla.r@futuremedia.net' },
  { id: '4', name: 'David Chen', title: 'Product Manager', company: 'Synergy Corp', photoUrl: 'https://picsum.photos/id/1012/200/200', email: 'david.chen@synergy.corp' },
  { id: '5', name: 'Elena Ivanova', title: 'Venture Capitalist', company: 'Quantum Ventures', photoUrl: 'https://picsum.photos/id/1013/200/200', email: 'elena@quantumventures.vc' },
  { id: '6', name: 'Frank Miller', title: 'CTO', company: 'DataWeave', photoUrl: 'https://picsum.photos/id/1014/200/200', email: 'frank.miller@dataweave.ai' },
];

export const MOCK_MEETINGS: Meeting[] = [
  {
    id: 'm1',
    title: 'Project Cygnus Kick-off',
    time: '10:00 AM - Today',
    attendees: [MOCK_PEOPLE[0], MOCK_PEOPLE[1]],
    source: 'google',
  },
  {
    id: 'm2',
    title: 'Marketing Strategy Sync',
    time: '2:00 PM - Today',
    attendees: [MOCK_PEOPLE[2]],
    source: 'zoho',
  },
  {
    id: 'm3',
    title: 'VC Funding Pitch',
    time: '9:00 AM - Tomorrow',
    attendees: [MOCK_PEOPLE[4], MOCK_PEOPLE[3]],
    source: 'microsoft',
  },
];