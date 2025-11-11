import { Person, Meeting, IntelligenceReport, GroundingChunk } from './types';

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

// Mock sources for intelligence reports
export const MOCK_SOURCES: Record<string, GroundingChunk[]> = {
  'alina-petrova': [
    { web: { uri: 'https://www.linkedin.com/in/alinapetrovaceo', title: 'Alina Petrova - CEO at InnovateX | LinkedIn' } },
    { web: { uri: 'https://techcrunch.com/2024/innovatex-series-b', title: 'InnovateX Raises $50M Series B Led by Top VCs - TechCrunch' } },
    { web: { uri: 'https://forbes.com/women-tech-leaders-2024', title: 'Forbes 30 Under 30: Women Leading Tech Innovation' } },
    { web: { uri: 'https://medium.com/@alinapetro/ai-future-saas', title: 'The Future of AI in Enterprise SaaS - Alina Petrova Blog' } },
    { web: { uri: 'https://innovatex.com/press/q4-2024-results', title: 'InnovateX Announces Record Q4 2024 Growth' } },
  ],
  'ben-carter': [
    { web: { uri: 'https://www.linkedin.com/in/ben-carter-engineer', title: 'Ben Carter - Lead Engineer at TechSolutions' } },
    { web: { uri: 'https://github.com/bcarter', title: 'Ben Carter (@bcarter) - GitHub' } },
    { web: { uri: 'https://dev.to/bcarter/microservices-kubernetes', title: 'Building Scalable Microservices with Kubernetes - Dev.to' } },
    { web: { uri: 'https://techsolutions.io/blog/engineering-excellence', title: 'Engineering Excellence at TechSolutions' } },
    { web: { uri: 'https://stackoverflow.com/users/bcarter', title: 'Ben Carter - Stack Overflow Profile' } },
  ],
  'carla-rodriguez': [
    { web: { uri: 'https://www.linkedin.com/in/carla-rodriguez-marketing', title: 'Carla Rodriguez - Marketing Director at Future Media' } },
    { web: { uri: 'https://adweek.com/digital-marketing-trends-2024', title: 'Top Digital Marketing Trends 2024 - Interview with Carla Rodriguez' } },
    { web: { uri: 'https://futuremedia.net/campaigns/viral-success', title: 'How We Created a Viral Campaign: A Case Study' } },
    { web: { uri: 'https://twitter.com/carlar_marketing', title: 'Carla Rodriguez (@carlar_marketing) - Twitter' } },
    { web: { uri: 'https://marketingweek.com/brand-storytelling', title: 'The Art of Brand Storytelling in 2024' } },
  ],
  'david-chen': [
    { web: { uri: 'https://www.linkedin.com/in/davidchen-pm', title: 'David Chen - Product Manager at Synergy Corp' } },
    { web: { uri: 'https://productcoalition.com/david-chen-product-led-growth', title: 'Product-Led Growth Strategies - David Chen' } },
    { web: { uri: 'https://synergy.corp/blog/customer-centric-product', title: 'Building Customer-Centric Products at Scale' } },
    { web: { uri: 'https://mind.com/@davidchen/product-roadmap-2024', title: 'How to Build a Winning Product Roadmap' } },
    { web: { uri: 'https://producthunt.com/@davidchen', title: 'David Chen - Product Hunt Profile' } },
  ],
  'elena-ivanova': [
    { web: { uri: 'https://www.linkedin.com/in/elena-ivanova-vc', title: 'Elena Ivanova - Partner at Quantum Ventures' } },
    { web: { uri: 'https://techcrunch.com/quantum-ventures-deep-tech-fund', title: 'Quantum Ventures Launches $200M Deep Tech Fund' } },
    { web: { uri: 'https://forbes.com/midas-list-2024', title: 'Forbes Midas List 2024: Top Tech Investors' } },
    { web: { uri: 'https://quantumventures.vc/portfolio', title: 'Quantum Ventures Portfolio Companies' } },
    { web: { uri: 'https://venturebeat.com/ai-investing-trends', title: 'AI Investing Trends: Insights from Leading VCs' } },
  ],
  'frank-miller': [
    { web: { uri: 'https://www.linkedin.com/in/frank-miller-cto', title: 'Frank Miller - CTO at DataWeave' } },
    { web: { uri: 'https://github.com/frankmiller', title: 'Frank Miller (@frankmiller) - GitHub' } },
    { web: { uri: 'https://infoq.com/presentations/data-architecture-scale', title: 'Building Data Architecture at Scale - Frank Miller' } },
    { web: { uri: 'https://dataweave.ai/blog/real-time-analytics', title: 'Real-Time Analytics: Lessons from the Trenches' } },
    { web: { uri: 'https://thenewstack.io/interview-frank-miller-dataweave', title: 'The New Stack: Data Engineering Best Practices' } },
  ],
};

// Mock intelligence reports for all people
export const MOCK_INTELLIGENCE_REPORTS: Record<string, IntelligenceReport> = {
  '1': { // Alina Petrova
    summary: 'Visionary CEO with 12+ years in enterprise SaaS and AI. Led InnovateX from seed to Series B ($50M raise). Known for strategic thinking, technical depth, and building high-performance teams. Forbes 30 Under 30 alumna with strong focus on AI-driven business transformation.',
    professionalBackground: {
      category: 'Professional Background',
      points: [
        {
          text: 'Founded InnovateX in 2019, scaling from 5 to 200+ employees with 300% YoY growth',
          confidence: 95,
          source_indices: [0, 1],
          timestamp: '2 weeks ago'
        },
        {
          text: 'Previously VP of Product at TechCorp, where she led AI/ML product initiatives generating $100M+ ARR',
          confidence: 88,
          source_indices: [0],
          timestamp: '1 month ago'
        },
        {
          text: 'M.S. in Computer Science from Stanford, specialized in Machine Learning and Distributed Systems',
          confidence: 92,
          source_indices: [0, 2],
        },
        {
          text: 'Named to Forbes 30 Under 30 in Enterprise Technology (2022) and recognized as one of the top women leaders in AI',
          confidence: 90,
          source_indices: [2],
          timestamp: '3 months ago'
        },
      ]
    },
    recentActivities: {
      category: 'Recent Activities',
      points: [
        {
          text: 'Announced InnovateX Series B funding round of $50M led by Sequoia Capital and Andreessen Horowitz',
          confidence: 98,
          source_indices: [1, 4],
          timestamp: '2 weeks ago'
        },
        {
          text: 'Published influential article on "The Future of AI in Enterprise SaaS" with 50K+ views',
          confidence: 85,
          source_indices: [3],
          timestamp: '3 weeks ago'
        },
        {
          text: 'Keynote speaker at TechCrunch Disrupt 2024 on "Building AI-First Companies"',
          confidence: 92,
          source_indices: [1],
          timestamp: '1 month ago'
        },
        {
          text: 'InnovateX announced record Q4 2024 results with 400% customer growth and expansion into European markets',
          confidence: 94,
          source_indices: [4],
          timestamp: '1 week ago'
        },
      ]
    },
    personalInterests: {
      category: 'Personal Interests',
      points: [
        {
          text: 'Passionate about mentoring women in tech - active mentor at Girls Who Code and hosts monthly "Coffee with Alina" sessions',
          confidence: 82,
          source_indices: [2, 3],
          timestamp: '2 months ago'
        },
        {
          text: 'Avid rock climber and marathoner - completed Boston Marathon 2024 and regularly shares fitness journey on LinkedIn',
          confidence: 75,
          source_indices: [0],
          timestamp: '4 months ago'
        },
        {
          text: 'Active angel investor in early-stage AI startups, with 15+ investments focused on diversity and inclusion',
          confidence: 88,
          source_indices: [2],
          timestamp: '2 months ago'
        },
      ]
    },
    discussionPoints: {
      category: 'Discussion Points',
      points: [
        {
          text: 'Explore potential partnership opportunities in AI/ML infrastructure - InnovateX is expanding its enterprise platform',
          confidence: 90,
          source_indices: [4],
        },
        {
          text: 'Discuss her perspective on building high-performance engineering teams and scaling company culture',
          confidence: 85,
          source_indices: [3],
        },
        {
          text: 'Ask about her vision for AI in enterprise SaaS over the next 5 years based on her recent thought leadership',
          confidence: 88,
          source_indices: [3, 1],
        },
        {
          text: 'Congratulate on recent Series B success and inquire about European expansion strategy',
          confidence: 95,
          source_indices: [1, 4],
        },
      ]
    }
  },
  '2': { // Ben Carter
    summary: 'Senior engineering leader with 10+ years building scalable distributed systems. Currently Lead Engineer at TechSolutions, specializing in microservices architecture and cloud infrastructure. Active open-source contributor with 12K+ GitHub stars across projects.',
    professionalBackground: {
      category: 'Professional Background',
      points: [
        {
          text: 'Lead Engineer at TechSolutions managing a team of 25+ engineers across 4 microservice platforms',
          confidence: 94,
          source_indices: [0, 3],
          timestamp: '1 month ago'
        },
        {
          text: 'Previously Senior Engineer at CloudScale Inc., where he architected their Kubernetes-based infrastructure serving 10M+ users',
          confidence: 90,
          source_indices: [0],
        },
        {
          text: 'Core contributor to several popular open-source projects including KubeFlow and Istio with 12K+ GitHub stars',
          confidence: 88,
          source_indices: [1, 4],
          timestamp: '2 weeks ago'
        },
        {
          text: 'B.S. in Computer Engineering from MIT, graduated with honors and published 3 papers on distributed systems',
          confidence: 85,
          source_indices: [0],
        },
      ]
    },
    recentActivities: {
      category: 'Recent Activities',
      points: [
        {
          text: 'Published comprehensive guide "Building Scalable Microservices with Kubernetes" on Dev.to with 25K+ reads',
          confidence: 95,
          source_indices: [2],
          timestamp: '1 week ago'
        },
        {
          text: 'Led TechSolutions migration to cloud-native architecture, reducing infrastructure costs by 40%',
          confidence: 92,
          source_indices: [3],
          timestamp: '3 weeks ago'
        },
        {
          text: 'Top contributor on Stack Overflow in Kubernetes and Docker tags with 50K+ reputation points',
          confidence: 87,
          source_indices: [4],
          timestamp: '2 months ago'
        },
        {
          text: 'Speaking at KubeCon 2024 on "Service Mesh Patterns for High-Performance Applications"',
          confidence: 89,
          source_indices: [2, 3],
          timestamp: '2 weeks ago'
        },
      ]
    },
    personalInterests: {
      category: 'Personal Interests',
      points: [
        {
          text: 'Passionate about developer education - maintains YouTube channel "Code with Ben" with 50K+ subscribers',
          confidence: 80,
          source_indices: [2],
          timestamp: '1 month ago'
        },
        {
          text: 'Amateur photographer specializing in landscape and astrophotography, regularly shares work on Instagram',
          confidence: 72,
          source_indices: [0],
        },
        {
          text: 'Active participant in hackathons and coding competitions, recently won Best Infrastructure Award at DevHacks 2024',
          confidence: 85,
          source_indices: [4],
          timestamp: '6 weeks ago'
        },
      ]
    },
    discussionPoints: {
      category: 'Discussion Points',
      points: [
        {
          text: 'Discuss microservices architecture patterns and his experience scaling systems to millions of users',
          confidence: 92,
          source_indices: [2, 3],
        },
        {
          text: 'Explore potential collaboration on infrastructure modernization and Kubernetes adoption',
          confidence: 88,
          source_indices: [2],
        },
        {
          text: 'Ask about his open-source philosophy and how he balances contribution with full-time engineering leadership',
          confidence: 85,
          source_indices: [1, 4],
        },
        {
          text: 'Inquire about upcoming KubeCon presentation and service mesh implementation best practices',
          confidence: 90,
          source_indices: [2, 3],
        },
      ]
    }
  },
  '3': { // Carla Rodriguez
    summary: 'Award-winning marketing strategist with 8+ years driving growth for media and tech brands. Marketing Director at Future Media, specializing in viral campaigns and brand storytelling. Known for data-driven creativity and building engaged communities.',
    professionalBackground: {
      category: 'Professional Background',
      points: [
        {
          text: 'Marketing Director at Future Media, leading a team of 15 across content, social, and performance marketing',
          confidence: 93,
          source_indices: [0, 2],
          timestamp: '2 months ago'
        },
        {
          text: 'Previously Head of Digital Marketing at BrandForge, where she grew social following from 50K to 2M+ in 18 months',
          confidence: 88,
          source_indices: [0],
        },
        {
          text: 'Created viral campaigns generating 100M+ impressions and featured in Adweek\'s "Top 10 Campaigns of 2024"',
          confidence: 95,
          source_indices: [1, 2],
          timestamp: '3 weeks ago'
        },
        {
          text: 'MBA in Marketing from Columbia Business School, specialized in Digital Strategy and Consumer Behavior',
          confidence: 85,
          source_indices: [0],
        },
      ]
    },
    recentActivities: {
      category: 'Recent Activities',
      points: [
        {
          text: 'Featured in Adweek interview on "Digital Marketing Trends 2024" discussing AI-powered personalization',
          confidence: 92,
          source_indices: [1],
          timestamp: '2 weeks ago'
        },
        {
          text: 'Published case study "How We Created a Viral Campaign" analyzing 50M+ impression campaign for major brand',
          confidence: 90,
          source_indices: [2],
          timestamp: '3 weeks ago'
        },
        {
          text: 'Grew Twitter following to 75K+ with daily marketing insights and industry commentary',
          confidence: 80,
          source_indices: [3],
          timestamp: '1 month ago'
        },
        {
          text: 'Keynote speaker at Marketing Week 2024 on "The Art of Brand Storytelling in the Age of AI"',
          confidence: 88,
          source_indices: [4],
          timestamp: '1 month ago'
        },
      ]
    },
    personalInterests: {
      category: 'Personal Interests',
      points: [
        {
          text: 'Passionate about supporting Latina entrepreneurs - founded "Latinas in Marketing" mentorship program with 200+ members',
          confidence: 85,
          source_indices: [0, 4],
          timestamp: '4 months ago'
        },
        {
          text: 'Food blogger and amateur chef, shares fusion recipes combining Latin American and Asian cuisines',
          confidence: 70,
          source_indices: [3],
        },
        {
          text: 'Active in community theater, recently directed a production of "In the Heights" for local arts center',
          confidence: 68,
          source_indices: [0],
        },
      ]
    },
    discussionPoints: {
      category: 'Discussion Points',
      points: [
        {
          text: 'Explore collaboration on brand strategy and viral marketing campaigns based on her proven track record',
          confidence: 90,
          source_indices: [1, 2],
        },
        {
          text: 'Discuss her approach to AI-powered marketing personalization and future trends in digital marketing',
          confidence: 88,
          source_indices: [1, 4],
        },
        {
          text: 'Ask about her experience building and scaling marketing teams in fast-growth environments',
          confidence: 85,
          source_indices: [0, 2],
        },
        {
          text: 'Congratulate on recent Adweek recognition and inquire about upcoming campaigns and initiatives',
          confidence: 92,
          source_indices: [1, 2],
        },
      ]
    }
  },
  '4': { // David Chen
    summary: 'Product visionary with 7+ years building customer-centric products at scale. Product Manager at Synergy Corp, leading cross-functional teams and driving product-led growth. Known for data-driven decision making and successful product launches with 1M+ users.',
    professionalBackground: {
      category: 'Professional Background',
      points: [
        {
          text: 'Senior Product Manager at Synergy Corp, leading 3 product teams and managing $20M+ product P&L',
          confidence: 94,
          source_indices: [0, 2],
          timestamp: '1 month ago'
        },
        {
          text: 'Previously PM at StartupFlow where he launched 5 products achieving 1M+ MAU and 95%+ retention rates',
          confidence: 90,
          source_indices: [0],
        },
        {
          text: 'Pioneer in product-led growth strategies, contributing to Product Coalition and Mind the Product publications',
          confidence: 88,
          source_indices: [1, 3],
          timestamp: '3 weeks ago'
        },
        {
          text: 'MBA from UC Berkeley Haas School of Business with focus on Product Management and Innovation',
          confidence: 85,
          source_indices: [0],
        },
      ]
    },
    recentActivities: {
      category: 'Recent Activities',
      points: [
        {
          text: 'Published "Product-Led Growth Strategies" article on Product Coalition with 30K+ reads and featured in newsletter',
          confidence: 92,
          source_indices: [1],
          timestamp: '2 weeks ago'
        },
        {
          text: 'Led launch of Synergy\'s new AI-powered analytics platform achieving 50K users in first month',
          confidence: 95,
          source_indices: [2],
          timestamp: '3 weeks ago'
        },
        {
          text: 'Wrote comprehensive guide "How to Build a Winning Product Roadmap" on Medium with 15K+ claps',
          confidence: 88,
          source_indices: [3],
          timestamp: '1 month ago'
        },
        {
          text: 'Active on Product Hunt with 20+ product launches and recognition as "Hunter of the Month" (Sept 2024)',
          confidence: 82,
          source_indices: [4],
          timestamp: '2 months ago'
        },
      ]
    },
    personalInterests: {
      category: 'Personal Interests',
      points: [
        {
          text: 'Mentor at Product School and Mind the Product communities, helping aspiring PMs break into tech',
          confidence: 85,
          source_indices: [1, 3],
          timestamp: '3 months ago'
        },
        {
          text: 'Enthusiastic home coffee roaster and barista, documenting coffee journey with 10K+ Instagram followers',
          confidence: 72,
          source_indices: [0],
        },
        {
          text: 'Weekend warrior cyclist, completed several century rides and active in local cycling community',
          confidence: 70,
          source_indices: [0],
        },
      ]
    },
    discussionPoints: {
      category: 'Discussion Points',
      points: [
        {
          text: 'Discuss product-led growth strategies and his approach to building customer-centric products at scale',
          confidence: 90,
          source_indices: [1, 2],
        },
        {
          text: 'Explore potential collaboration on product strategy and roadmap development',
          confidence: 88,
          source_indices: [3],
        },
        {
          text: 'Ask about recent AI analytics platform launch and lessons learned from achieving 50K users in first month',
          confidence: 92,
          source_indices: [2],
        },
        {
          text: 'Inquire about his framework for prioritizing features and balancing user needs with business goals',
          confidence: 85,
          source_indices: [1, 3],
        },
      ]
    }
  },
  '5': { // Elena Ivanova
    summary: 'Prominent venture capitalist with 15+ years investing in deep tech and AI startups. Partner at Quantum Ventures managing $500M+ fund. Forbes Midas List investor known for early-stage bets on breakthrough technologies. Portfolio includes 8 unicorns and 30+ successful exits.',
    professionalBackground: {
      category: 'Professional Background',
      points: [
        {
          text: 'General Partner at Quantum Ventures, leading $200M Deep Tech Fund focused on AI, quantum computing, and biotech',
          confidence: 96,
          source_indices: [0, 1],
          timestamp: '1 month ago'
        },
        {
          text: 'Previously Principal at Sequoia Capital where she led investments in 15+ companies with combined valuation of $10B+',
          confidence: 92,
          source_indices: [0],
        },
        {
          text: 'Named to Forbes Midas List 2024 as one of world\'s top 100 tech investors with 8 unicorn companies in portfolio',
          confidence: 95,
          source_indices: [2],
          timestamp: '2 months ago'
        },
        {
          text: 'Ph.D. in Physics from MIT and MBA from Harvard Business School, rare combination of deep tech and business expertise',
          confidence: 88,
          source_indices: [0, 2],
        },
      ]
    },
    recentActivities: {
      category: 'Recent Activities',
      points: [
        {
          text: 'Announced launch of Quantum Ventures $200M Deep Tech Fund targeting AI infrastructure and quantum computing startups',
          confidence: 98,
          source_indices: [1],
          timestamp: '1 month ago'
        },
        {
          text: 'Led Series A investment in QuantumAI, a quantum computing startup, at $100M valuation',
          confidence: 94,
          source_indices: [3],
          timestamp: '2 weeks ago'
        },
        {
          text: 'Featured in VentureBeat article on "AI Investing Trends" sharing insights on enterprise AI and infrastructure',
          confidence: 90,
          source_indices: [4],
          timestamp: '3 weeks ago'
        },
        {
          text: 'Portfolio company NeuralTech acquired by Google for $1.2B, marking her 5th unicorn exit this year',
          confidence: 92,
          source_indices: [3],
          timestamp: '1 week ago'
        },
      ]
    },
    personalInterests: {
      category: 'Personal Interests',
      points: [
        {
          text: 'Passionate advocate for women in STEM and venture capital - founded "Women in Deep Tech" initiative supporting 100+ female founders',
          confidence: 88,
          source_indices: [2, 4],
          timestamp: '4 months ago'
        },
        {
          text: 'Classical pianist who performs at charity events, recently raised $500K for STEM education at gala performance',
          confidence: 78,
          source_indices: [0],
          timestamp: '5 months ago'
        },
        {
          text: 'Board member at MIT and advisor to several university deep tech accelerators',
          confidence: 90,
          source_indices: [0, 2],
        },
      ]
    },
    discussionPoints: {
      category: 'Discussion Points',
      points: [
        {
          text: 'Explore funding opportunities for AI/deep tech ventures - Quantum Ventures actively deploying new $200M fund',
          confidence: 95,
          source_indices: [1, 3],
        },
        {
          text: 'Discuss her perspective on AI infrastructure and where she sees biggest opportunities in next 3-5 years',
          confidence: 92,
          source_indices: [4],
        },
        {
          text: 'Ask about her experience transitioning from physics research to venture capital and building deep tech investment thesis',
          confidence: 88,
          source_indices: [0, 2],
        },
        {
          text: 'Congratulate on recent portfolio exits and Forbes Midas List recognition',
          confidence: 94,
          source_indices: [2, 3],
        },
      ]
    }
  },
  '6': { // Frank Miller
    summary: 'Distinguished engineering executive with 15+ years building data infrastructure at scale. CTO at DataWeave leading 80+ engineers across data, ML, and platform teams. Former architect at major tech companies with patents in distributed systems and real-time analytics.',
    professionalBackground: {
      category: 'Professional Background',
      points: [
        {
          text: 'Chief Technology Officer at DataWeave, leading engineering org of 80+ across data infrastructure, ML platform, and SRE',
          confidence: 96,
          source_indices: [0, 3],
          timestamp: '2 months ago'
        },
        {
          text: 'Previously Distinguished Engineer at Amazon Web Services, where he architected data pipeline processing 10B+ events/day',
          confidence: 92,
          source_indices: [0],
        },
        {
          text: 'Holds 12 patents in distributed systems, stream processing, and real-time analytics',
          confidence: 90,
          source_indices: [0, 2],
        },
        {
          text: 'Ph.D. in Computer Science from Carnegie Mellon focusing on distributed databases and fault-tolerant systems',
          confidence: 88,
          source_indices: [0],
        },
      ]
    },
    recentActivities: {
      category: 'Recent Activities',
      points: [
        {
          text: 'Presented "Building Data Architecture at Scale" at InfoQ conference on processing petabyte-scale data in real-time',
          confidence: 94,
          source_indices: [2],
          timestamp: '2 weeks ago'
        },
        {
          text: 'Led DataWeave\'s infrastructure overhaul reducing query latency by 10x and costs by 60%',
          confidence: 95,
          source_indices: [3],
          timestamp: '1 month ago'
        },
        {
          text: 'Published "Real-Time Analytics: Lessons from the Trenches" sharing insights from building systems at AWS and DataWeave',
          confidence: 92,
          source_indices: [3],
          timestamp: '3 weeks ago'
        },
        {
          text: 'Featured in The New Stack interview on "Data Engineering Best Practices" discussing modern data stack and tooling',
          confidence: 88,
          source_indices: [4],
          timestamp: '1 week ago'
        },
      ]
    },
    personalInterests: {
      category: 'Personal Interests',
      points: [
        {
          text: 'Active open-source contributor maintaining popular data processing libraries with 30K+ GitHub stars combined',
          confidence: 85,
          source_indices: [1],
          timestamp: '2 months ago'
        },
        {
          text: 'Mentor at Recurse Center and speaks at university career fairs encouraging students to pursue data engineering',
          confidence: 80,
          source_indices: [0],
        },
        {
          text: 'Passionate woodworker and furniture maker, applies engineering principles to custom furniture design',
          confidence: 65,
          source_indices: [0],
        },
      ]
    },
    discussionPoints: {
      category: 'Discussion Points',
      points: [
        {
          text: 'Discuss data architecture patterns and his experience building petabyte-scale real-time analytics systems',
          confidence: 94,
          source_indices: [2, 3],
        },
        {
          text: 'Explore potential partnership on data infrastructure modernization and performance optimization',
          confidence: 90,
          source_indices: [3],
        },
        {
          text: 'Ask about his approach to building and scaling engineering teams - grew DataWeave eng from 20 to 80+',
          confidence: 88,
          source_indices: [0, 4],
        },
        {
          text: 'Inquire about recent infrastructure overhaul achieving 10x performance improvement and lessons learned',
          confidence: 92,
          source_indices: [3],
        },
      ]
    }
  },
};