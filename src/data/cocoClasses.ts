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

// Fine-grained 1,000-class ImageNet + worldwide retail/consumer product suggestions
export const WORLD_PRODUCT_SUGGESTIONS: string[] = [
  ...COCO_CLASSES,
  'water bottle', 'pop bottle', 'wine bottle', 'pill bottle', 'beer bottle', 'soda can',
  'energy drink', 'coffee mug', 'espresso maker', 'teapot', 'perfume', 'lotion', 'shampoo',
  'lipstick', 'soap dispenser', 'sunscreen', 'toothpaste', 'face mask', 'sunglasses',
  'digital watch', 'analog watch', 'wallet', 'headphones', 'earbuds', 'microphone',
  'camera', 'reflex camera', 'printer', 'monitor', 'joystick', 'router', 'power bank',
  'charger', 'usb drive', 'packet', 'carton', 'snacks', 'chocolate', 'biscuit', 'chips',
  'cereal box', 'medicine', 'first-aid kit', 'syringe', 'stethoscope', 'hammer',
  'screwdriver', 'wrench', 'cleaver', 'hatchet', 'pocket knife', 'cigarette', 'lighter',
  'helmet', 'running shoe', 'sneaker', 'jacket', 'coca-cola', 'pepsi', 'red bull',
  'panadol', 'dettol', 'colgate', 'iphone', 'samsung', 'macbook',
];

export const CLASS_SYNONYMS: Record<string, string[]> = {
  'cell phone': ['phone', 'mobile', 'smartphone', 'iphone', 'samsung', 'android', 'handset', 'cellular telephone'],
  'person': ['human', 'man', 'woman', 'people', 'face', 'intruder', 'visitor'],
  'laptop': ['computer', 'notebook', 'notebook computer', 'macbook', 'pc'],
  'knife': ['blade', 'cutter', 'dagger', 'weapon', 'cleaver', 'pocket knife'],
  'scissors': ['shear', 'shears', 'cutter'],
  'cup': ['mug', 'coffee mug', 'coffee', 'tea', 'glass', 'espresso'],
  'bottle': ['water bottle', 'pop bottle', 'pill bottle', 'wine bottle', 'beer bottle', 'water', 'drink', 'flask', 'jar', 'coca-cola', 'pepsi'],
  'backpack': ['bag', 'rucksack', 'schoolbag'],
  'handbag': ['purse', 'bag', 'tote', 'wallet'],
  'suitcase': ['luggage', 'baggage', 'briefcase'],
  'tv': ['monitor', 'screen', 'television'],
  'book': ['notebook', 'diary', 'magazine', 'book jacket', 'comic book'],
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
    positive: ['person', 'laptop', 'backpack', 'water bottle', 'book'],
    negative: ['knife', 'scissors', 'cell phone', 'baseball bat'],
  },
  {
    id: 'retail_audit',
    name: 'Global Product Audit',
    description: 'Approves water & coffee, alerts on soda cans, snacks, or medicines.',
    positive: ['water bottle', 'coffee mug', 'apple', 'book', 'laptop'],
    negative: ['coca-cola', 'pepsi', 'pop bottle', 'energy drink', 'cigarette'],
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
    description: 'Approves fruits & cups, sounds siren on sharp utensils & pills.',
    positive: ['apple', 'banana', 'orange', 'cup', 'bottle', 'bowl'],
    negative: ['knife', 'scissors', 'fork', 'pill bottle', 'lighter'],
  },
];

export const DEFAULT_RULES: VisionRules = {
  positive: RULE_PRESETS[0].positive,
  negative: RULE_PRESETS[0].negative,
  confidenceThreshold: 0.45,
  unlistedMode: 'neutral',
};
