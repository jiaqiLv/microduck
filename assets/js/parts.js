/**
 * 部件数据与匹配规则。
 *
 * 这里是全站唯一的一份“部件说明”数据：3D 高亮、右侧信息卡、下方芯片、
 * 以及页面下半部分的卡片列表都从 PARTS 生成，改文案只改这一个文件。
 *
 * 匹配顺序有意义：先匹配“舵机”“脚”这类跨部位的零件，再落到具体身体。
 */

/** @typedef {{id:string,label:string,role:string,tags:string[],bullets:{t:string,d:string}[],hotspot?:string}} Part */

export const PARTS = [
  {
    id: 'head',
    label: '头部',
    role: '感知与表达',
    tags: ['4 自由度', '相机', 'ToF', '扬声器'],
    hotspot: 'head_camera',
    bullets: [
      {
        t: '4 个自由度',
        d: 'neck_pitch / head_pitch / head_yaw / head_roll —— 低头、抬头、转头、歪头，全部由策略直接输出。',
      },
      {
        t: '相机',
        d: '前脸的 m12 镜头座与镜片，mediad 采集后编码成 H.264，console 与远程 WebRTC 都从这一路出图。',
      },
      {
        t: 'ToF 深度',
        d: 'VL53L5CX，8×8 分区、45° 方视场、最远 4 m；tofd 以 15 Hz 独立发布，谁都可以读。',
      },
      {
        t: '扬声器',
        d: 'quack 的声音从这里出。每只鸭子的声纹由身份 seed 生成，两只鸭子不会共用一副嗓子。',
      },
    ],
  },
  {
    id: 'beak',
    label: '喙',
    role: '唯一的夹取执行器',
    tags: ['1 个舵机', '软胶'],
    bullets: [
      {
        t: '单独的第 15 个舵机',
        d: '开合不在这 14 维策略动作里：策略管身体，喙由独立指令驱动，所以夹取不会干扰平衡。',
      },
      {
        t: '软胶上喙',
        d: 'soft_mouth_top 是柔性件，闭合时能夹住轻物体而不把物体顶飞。',
      },
      {
        t: '嘴尖是参考点',
        d: 'mouth_tip 这个 site 同时给捡物技能和碰撞判定用；低头捡物就是“喙触地 → 闭合 → 起身”。',
      },
    ],
  },
  {
    id: 'neck',
    label: '颈部',
    role: '头部姿态的传动',
    tags: ['3 个舵机', '串联'],
    bullets: [
      {
        t: '三段串联',
        d: 'neck_pitch、head_pitch、head_yaw 三个 XL330 串起来，把 4 维头部指令变成实际姿态。',
      },
      {
        t: '策略最直接的“表情”',
        d: '颈部负载轻、惯性小，指令跟不跟得上，看这一段最清楚。',
      },
      {
        t: '观测里的一环',
        d: '头部目标姿态（四元数，4 维）与关节位置一起进 61 维观测，所以转头不是回放动画。',
      },
    ],
  },
  {
    id: 'torso',
    label: '躯干',
    role: '电池、计算与髋部',
    tags: ['NP-F970 电池', 'RK3566', 'IMU'],
    hotspot: 'imu',
    bullets: [
      {
        t: '电池与配重',
        d: 'NP-F970 电池组 + power_support 撑起整机重心；训练时的 com_range 随机化扰动的就是它。',
      },
      {
        t: '计算单元',
        d: '量产版是 Rockchip RK3566，跑 Linux 与七个 daemon；CAD 里这块 PCB 还是早期 HAT 形状的网格。',
      },
      {
        t: 'IMU 在壳内',
        d: '板载 IMU 挂在舵机总线上（设备 id 200），和 15 个舵机在同一次 sync_read 里读回。',
      },
      {
        t: '仿真里的根节点',
        d: 'trunk_base 就是 freejoint 的根，世界坐标、速度、姿态都记在它身上。',
      },
    ],
  },
  {
    id: 'leg-left',
    label: '左腿',
    role: '5 自由度',
    tags: ['髋 yaw / roll / pitch', '膝', '踝'],
    bullets: [
      {
        t: '5 个 XL330',
        d: '髋偏航、髋横滚、髋俯仰、膝、踝——每条腿 5 个，两条腿 10 个，占 14 维动作的绝大部分。',
      },
      {
        t: '连杆传力',
        d: '连杆 + 刚性板把舵机力矩送到脚上，轴承吃掉侧向力，所以小腿能做得比舵机更细。',
      },
      {
        t: '站立与行走是同一套关节',
        d: '站住、走、被推倒后爬起来，都是这 10 个关节在动，没有“站立动画”这种分支。',
      },
    ],
  },
  {
    id: 'leg-right',
    label: '右腿',
    role: '5 自由度',
    tags: ['髋 yaw / roll / pitch', '膝', '踝'],
    bullets: [
      {
        t: '镜像但不完全对称',
        d: '关节限位左右略有差别（髋偏航左 −25°~+30°，右 −30°~+25°），仿真里按真实限位建模。',
      },
      {
        t: '跌倒恢复的主力',
        d: '侧翻后通常是右腿先找回支撑面，再带动左腿——这是策略自己学出来的，不是脚本。',
      },
      {
        t: '单腿失效即整机失效',
        d: '一个舵机过载跳闸，robotd 会判定不健康并卸力，不会带着坏腿硬走。',
      },
    ],
  },
  {
    id: 'servo',
    label: 'XL330 舵机',
    role: '15 个执行器',
    tags: ['Dynamixel', '1 Mbps', '固件 ≥ v46'],
    bullets: [
      {
        t: '15 个，分工明确',
        d: '两条腿 10 个 + 头部 4 个 + 喙 1 个，全部是 Dynamixel XL330-M288-T。',
      },
      {
        t: '一根总线',
        d: '1 Mbps 的舵机总线上还挂着 IMU（id 200），一次 sync_read 读回全部状态，控制环因此能稳在 50 Hz。',
      },
      {
        t: '回读不只是位置',
        d: '位置、速度、电流、温度都回读，限位、过载保护、跌倒判断全靠这些量。',
      },
      {
        t: '仿真里不是理想力矩源',
        d: '用 BAM 模型拟合真实舵机的 kp、阻尼与摩擦——这是 sim2real 能站住的关键一环。',
      },
    ],
  },
  {
    id: 'foot',
    label: '脚掌与鞋底',
    role: '唯一的接地点',
    tags: ['橙色脚掌', '黄色鞋底'],
    bullets: [
      {
        t: '两层结构',
        d: 'foot_left / foot_right 是橙色脚掌，sole_left / sole_right 是黄色耐磨鞋底，磨损换鞋底即可。',
      },
      {
        t: '接触检测点',
        d: '脚底 site 给里程计做接触判断，走路时“有没有真的踩实”由它回答。',
      },
      {
        t: 'sim2real 的最大变量',
        d: '地面摩擦、鞋底磨损、接触刚度都会改步态；训练里靠摩擦与接触参数随机化覆盖这一块。',
      },
    ],
  },
  {
    id: 'imu',
    label: 'IMU',
    role: '姿态与重力',
    tags: ['总线设备 id 200', '投影重力'],
    hotspot: 'imu',
    highlightWith: 'torso',
    bullets: [
      {
        t: '挂在舵机总线上',
        d: '不是独立的 USB 设备：作为 id 200 与 15 个舵机共用一次事务，省掉一整条总线。',
      },
      {
        t: '策略的平衡感',
        d: '3 维角速度 + 3 维投影重力进观测；投影重力告诉策略“哪边是下”，比四元数更好学。',
      },
      {
        t: '仿真侧同接口',
        d: 'MuJoCo 只给四元数，body 侧做同样的投影计算，所以策略分不出真假。',
      },
    ],
  },
  {
    id: 'tof',
    label: 'ToF 深度',
    role: '8×8 深度矩阵',
    tags: ['VL53L5CX', '15 Hz', '45° 视场'],
    hotspot: 'tof',
    highlightWith: 'head',
    bullets: [
      {
        t: '一颗 8×8 的“复眼”',
        d: 'VL53L5CX 把 45° 方视场切成 64 个区，每区一个距离，最远 4 m。',
      },
      {
        t: '独立进程',
        d: 'tofd 只做一件事：按 15 Hz 发帧，不读别人的数据。没装传感器的板子也照常启动并说明原因。',
      },
      {
        t: '仿真里也真的转',
        d: '射线来自模型里的 tof site，头转过去，深度图跟着转——不是假的固定视角。',
      },
      {
        t: '还没被策略用上',
        d: '目前它是“装着的余量”：深度可用，但官方步态策略只用本体感知。',
      },
    ],
  },
  {
    id: 'camera',
    label: '相机',
    role: '视觉与远程入口',
    tags: ['m12 镜头', 'H.264'],
    hotspot: 'head_camera',
    highlightWith: 'head',
    bullets: [
      {
        t: '前脸主摄',
        d: 'm12 镜头座 + 镜片，装在头部中轴，随头一起转。',
      },
      {
        t: '数据面的起点',
        d: 'mediad 采集、编码，console（:8080）与 WebRTC（:8443）都从这里取流；控制指令永远不走这一路。',
      },
      {
        t: '录像与感知',
        d: '本项目的动作视频就是这条链路录出来的；宠物检测之类的视觉功能也挂在它后面。',
      },
    ],
  },
];

/** 身体名 → 部件 id，未列出的身体返回 null。 */
const BODY_PART = {
  trunk_base: 'torso',
  jaw_soft: 'head',
  neck: 'neck',
  neck_pitch: 'neck',
  yaw_roll_motion: 'neck',
  yaw2roll: 'leg-left',
  hip_l: 'leg-left',
  upper_leg_left: 'leg-left',
  leg: 'leg-left',
  ankle_left: 'leg-left',
  bearing_roll: 'leg-right',
  hip_l_2: 'leg-right',
  upper_leg_right: 'leg-right',
  leg_2: 'leg-right',
  ankle_right: 'leg-right',
};

const BEAK_MESHES = new Set(['jaw', 'jaw_soft', 'soft_mouth_top', 'motor_support']);

/**
 * 一个 glTF 节点属于哪个部件。
 * @param {{body:string, mesh:string}} node
 * @returns {string|null}
 */
export function partForNode(node) {
  const { body, mesh } = node;
  if (mesh === 'xl330') return 'servo';
  if (mesh.startsWith('foot_') || mesh.startsWith('sole_')) return 'foot';
  if (body === 'jaw_soft' && BEAK_MESHES.has(mesh)) return 'beak';
  return BODY_PART[body] ?? null;
}

export const PART_BY_ID = new Map(PARTS.map((p) => [p.id, p]));
