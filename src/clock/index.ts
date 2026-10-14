/** `eharness/clock`: the `datetime` tool and zone arithmetic (spec 34). */
export {
  type ClockOptions,
  clock,
  DATETIME_DESCRIPTION,
  type DatetimeInput,
  runDatetime,
} from './plugin.ts'
export {
  addDays,
  addToMoment,
  diffMoments,
  durationWords,
  formatInZone,
  fromZoned,
  isValidTimeZone,
  type LocalDate,
  nowLine,
  offsetLabel,
  parseDate,
  parseMoment,
  type Shift,
  type ZonedParts,
  zonedParts,
} from './time.ts'
