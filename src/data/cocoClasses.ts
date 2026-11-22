import { RulePreset, VisionRules } from '../types/vision';

export const COCO_CLASSES: string[] = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
];

export const CLASS_SYNONYMS: Record<string, string[]> = {
  'cell phone': ['phone', 'mobile', 'smartphone', 'iphone', 'android', 'handset'],
  'person': ['human', 'man', 'woman', 'people', 'face', 'intruder', 'visitor'],
  'laptop': ['computer', 'notebook', 'macbook', 'pc'],
  'knife': ['blade', 'cutter', 'dagger', 'weapon'],
  'scissors': ['shear', 'shears', 'cutter'],
  'cup': ['mug', 'coffee', 'tea', 'glass'],
  'bottle': ['water', 'drink', 'flask', 'jar'],
  'backpack': ['bag', 'rucksack', 'schoolbag'],
  'handbag': ['purse', 'bag', 'tote'],
  'suitcase': ['luggage', 'baggage', 'briefcase'],
  'tv': ['monitor', 'screen', 'television'],
  'book': ['notebook', 'diary', 'magazine'],
  'potted plant': ['plant', 'flower', 'pot'],
  'couch': ['sofa'],
  'dining table': ['table', 'desk'],
  'sports ball': ['ball', 'football', 'soccer', 'basketball'],
  'wine glass': ['glass', 'wine'],
  'baseball bat': ['bat', 'stick', 'weapon'],
};

export const RULE_PRESETS: RulePreset[] = [
  {
    id: 'security',
    name: 'Security Screening',
    description: 'Allows personnel & work gear, flags blades & restricted phones.',
    positive: ['person', 'laptop', 'backpack', 'bottle', 'book'],
    negative: ['knife', 'scissors', 'cell phone', 'baseball bat'],
  },
  {
    id: 'focus',
    name: 'Focus Workspace',
    description: 'Encourages study & work tools, alerts on phone or TV distractions.',
    positive: ['book', 'laptop', 'keyboard', 'mouse', 'cup'],
    negative: ['cell phone', 'remote', 'tv', 'wine glass'],
  },
  {
    id: 'kitchen',
    name: 'Child-Safe Kitchen',
    description: 'Approves fruits & cups, sounds siren on sharp utensils.',
    positive: ['apple', 'banana', 'orange', 'cup', 'bottle', 'bowl'],
    negative: ['knife', 'scissors', 'fork'],
  },
  {
    id: 'retail',
    name: 'Showroom Floor',
    description: 'Welcomes customers & bags, flags pets or cycles indoors.',
    positive: ['person', 'handbag', 'suitcase', 'tie', 'clock'],
    negative: ['dog', 'cat', 'bicycle', 'skateboard'],
  },
];

export const DEFAULT_RULES: VisionRules = {
  positive: RULE_PRESETS[0].positive,
  negative: RULE_PRESETS[0].negative,
  confidenceThreshold: 0.5,
  unlistedMode: 'neutral',
};
