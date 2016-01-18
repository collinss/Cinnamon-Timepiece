const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Cairo = imports.gi.cairo;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const PangoCairo = imports.gi.PangoCairo;
const St = imports.gi.St;

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu
const Settings = imports.ui.settings;
const Tooltips = imports.ui.tooltips;

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Params = imports.misc.params;
const Signals = imports.signals;
const Util = imports.misc.util;


let settings, button_path, displayBox;


function SettingsManager(uuid, instanceId) {
    this._init(uuid, instanceId);
}

SettingsManager.prototype = {
    _init: function(uuid, instanceId) {
        this.settings = new Settings.AppletSettings(this, uuid, instanceId);
        this.bind("alarms", "BIDIRECTIONAL");
        this.bind("alarmSound", "IN");
        this.bind("timerSound", "IN");
    },
    
    bind: function(prop, direction, callback) {
        this.settings.bindProperty(Settings.BindingDirection[direction], prop, prop, callback);
    }
}


function Spinner(params) {
    this._init(params);
}

Spinner.prototype = {
    _init: function(params) {
        try {
            
            this.params = Params.parse(params, {
                min: 0,
                max: 9,
                defaultValue: 1,
                step: 1,
                leadingZeros: false,
                rollover: false
            });
            
            this.actor = new St.BoxLayout({ reactive: true, vertical: true, style_class: "spinButton-box" });
            this.actor.connect("scroll-event", Lang.bind(this, this.onScroll));
            
            this.increaseButton = new St.Button({ label: "+", style_class: "spinButton-buttonUp" });
            this.actor.add_actor(this.increaseButton);
            this.increaseButton.connect("button-press-event", Lang.bind(this, this.onPressed, true));
            
            this.display = new St.Label({ style_class: "spinButton-display" });
            this.actor.add_actor(this.display);
            
            this.decreaseButton = new St.Button({ label: "-", style_class: "spinButton-buttonDown" });
            this.actor.add_actor(this.decreaseButton);
            this.decreaseButton.connect("button-press-event", Lang.bind(this, this.onPressed, false));
            
            this.setValue(this.params.defaultValue);
            
        } catch(e) {
            global.logError(e);
        }
    },
    
    onScroll: function(actor, event) {
        direction = event.get_scroll_direction();
        if ( direction == Clutter.ScrollDirection.UP ) this.increase();
        else if ( direction == Clutter.ScrollDirection.DOWN ) this.decrease();
    },
    
    onPressed: function(button, event, isUp) {
        this.onReleasedId = button.connect("button-release-event", Lang.bind(this, this.onReleased));
        this.canAutoScroll = true;
        if ( isUp ) this.increase();
        else this.decrease();
        
        Mainloop.timeout_add(300, Lang.bind(this, this.autoScroll, isUp));
    },
    
    onReleased: function(button) {
        this.canAutoScroll = false;
        button.disconnect(this.onReleasedId);
    },
    
    autoScroll: function(isUp) {
        if ( !this.canAutoScroll ) return;
        
        if ( isUp ) this.increase();
        else this.decrease();
        
        Mainloop.timeout_add(Math.floor(1000/this.params.max), Lang.bind(this, this.autoScroll, isUp));
    },
    
    increase: function() {
        this.value++;
        if ( this.value > this.params.max ) {
            if ( this.params.rollover ) {
                this.value = this.params.min;
                this.emit("rollover", true);
            }
            else {
                this.value = this.params.max;
            }
        }
        this.updateDisplay();
    },
    
    decrease: function() {
        this.value--;
        if ( this.value < this.params.min ) {
            if ( this.params.rollover ) {
                this.value = this.params.max;
                this.emit("rollover", false);
            }
            else {
                this.value = this.params.max;
            }
        }
        this.updateDisplay();
    },
    
    setValue: function(value) {
        this.value = value;
        this.updateDisplay();
    },
    
    getValue: function() {
        return this.value;
    },
    
    updateDisplay: function() {
        //this.increaseButton.disable();
        
        let display = String(this.value);
        if ( this.params.leadingZeros ) {
            let digits = Math.floor(Math.log(this.params.max)/Math.log(10) + 1);
            while ( display.length < digits ) display = "0" + display;
        }
        
        this.display.text = display;
    }
}
Signals.addSignalMethods(Spinner.prototype);


function ClockSelector(count, max, value, target, callback) {
    this._init(count, max, value, target, callback);
}

ClockSelector.prototype = {
    _init: function(count, max, value, target, callback) {
        this.count = count;
        this.max = max;
        this.value = value;
        this.callback = callback;
        this.stageEvents = [];
        
        this.actor = new St.Bin({ style_class: "timepiece-clockSelect" });
        Main.uiGroup.add_actor(this.actor);
        Main.pushModal(this.actor);
        let [x, y] = target.get_transformed_position();
        this.actor.set_position(x, y);
        
        this.clock = new St.DrawingArea({ style_class: "timepiece-clock", reactive: true, track_hover: true });
        this.actor.add_actor(this.clock);
        this.clock.connect("button-press-event", Lang.bind(this, this.onButtonPressed));
        this.clock.connect("repaint", Lang.bind(this, this.repaintClock));
        this.clock.connect("scroll-event", Lang.bind(this, this.onScroll));
        this.stageEvents.push(global.stage.connect("captured-event", Lang.bind(this, this.onStageEvent)));
        this.stageEvents.push(global.stage.connect("enter-event", Lang.bind(this, this.onStageEvent)));
        this.stageEvents.push(global.stage.connect("leave-event", Lang.bind(this, this.onStageEvent)));
        this.clock.queue_repaint();
    },
    
    repaintClock: function(area) {
        let context = area.get_context();
        let themeNode = area.get_theme_node();
        let [width, height] = area.get_surface_size();
        
        let centerX = width/2;
        let centerY = height/2;
        
        let font = themeNode.get_font();
        let textColor = themeNode.get_color("color");
        let numberDistance = themeNode.get_length("-number-distance");
        
        // draw the circle
        let circleRadius = Math.min(themeNode.get_length("-circle-radius"),
                                    (width / 2) - numberDistance - font.get_size()/1024,
                                    (height / 2) - numberDistance - font.get_size()/1024);
        let circleWidth = themeNode.get_length("-circle-width");
        let circleColor = themeNode.get_color("-circle-color");
        
        context.setSourceRGBA (
            circleColor.red / 255,
            circleColor.green / 255,
            circleColor.blue / 255,
            circleColor.alpha / 255);
        context.arc(centerX, centerY, circleRadius, 0, 2 * Math.PI);
        context.setLineWidth(circleWidth);
        context.stroke();
        
        // draw the numbers
        for ( let i = 1; i <= 12; i++ ) {
            context.setSourceRGBA (
                textColor.red / 255,
                textColor.green / 255,
                textColor.blue / 255,
                textColor.alpha / 255);
            
            let layout = PangoCairo.create_layout(context);
            layout.set_font_description(font);
            layout.set_text(String(i*this.count), -1);
            
            let extents = layout.get_extents()[1];
            let textX = centerX + Math.sin(i*Math.PI/6) * (circleRadius + numberDistance) - extents.width/1024/2;
            let textY = centerY - Math.cos(i*Math.PI/6) * (circleRadius + numberDistance) - extents.height/1024/2;
            context.moveTo(textX, textY);
            PangoCairo.show_layout(context, layout);
        }
        
        // draw the arm
        let armLenth = themeNode.get_length("-arm-length");
        let armWidth = themeNode.get_length("-arm-width");
        let armColor = themeNode.get_color("-arm-color");
        
        context.setSourceRGBA (
            armColor.red / 255,
            armColor.green / 255,
            armColor.blue / 255,
            armColor.alpha / 255);
        
        context.moveTo(centerX, centerY);
        context.lineTo(centerX + armLenth * Math.sin(this.value*2*Math.PI/this.max),
                       centerY - armLenth * Math.cos(this.value*2*Math.PI/this.max));
        context.setLineWidth(armWidth);
        context.stroke();
    },
    
    close: function() {
        for ( let id of this.stageEvents ) global.stage.disconnect(id);
        Main.popModal(this.actor);
        this.actor.destroy();
    },
    
    onButtonPressed: function(actor, event) {
        Clutter.grab_pointer(this.clock);
        if ( !this.dragging ) {
            this.motionId = this.clock.connect("motion-event", Lang.bind(this, this.onMotionEvent));
            this.releaseId = this.clock.connect("button-release-event", Lang.bind(this, this.onButtonReleased));
        }
        
        this.dragging = true;
        this.updatePosition(event);
    },
    
    onMotionEvent: function(actor, event) {
        this.updatePosition(event);
    },
    
    onButtonReleased: function(actor, event) {
        Clutter.ungrab_pointer();
        this.close();
    },
    
    onScroll: function(event) {
        let direction = event.get_scroll_direction();
        switch ( event.get_scroll_direction() ) {
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.LEFT:
                this.value--;
                break;
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.RIGHT:
                this.value++;
                break;
        }
        
        // make sure everything is within bounds
        if ( this.value < 0 ) this.value = this.max;
        else if ( this.value >= this.max ) this.value = 0;
        
        this.clock.queue_repaint();
        this.callback(this.value);
    },
    
    onStageEvent: function(actor, event) {
        if ( event.type() == Clutter.EventType.KEY_PRESS ) {
            if ( event.get_key_symbol() == Clutter.KEY_Escape ) this.close();
            return true;
        }
        
        let target = event.get_source();
        if ( target == this.actor || this.actor.contains(target) ) return false;
        if ( event.type() == Clutter.EventType.BUTTON_PRESS ||
             event.type() == Clutter.EventType.BUTTON_RELEASE ) this.close();
        return true;
    },
    
    updatePosition: function(event) {
        let [stageX, stageY] = event.get_coords();
        let [a, x, y] = this.clock.transform_stage_point(stageX,stageY);
        
        let centerX = this.clock.width / 2;
        let centerY = this.clock.height / 2;
        
        let angle = 180 - Math.atan2(x-centerX, y-centerY) * 180 / Math.PI;
        this.value = Math.round(angle * this.max / 360);
        
        this.clock.queue_repaint();
        this.callback(this.value);
    }
}


function TimeSelectDialog(callback) {
    this._init(callback);
}

TimeSelectDialog.prototype = {
    __proto__: ModalDialog.ModalDialog.prototype,
    
    _init: function(callback) {
        this.callback = callback;
        
        ModalDialog.ModalDialog.prototype._init.call(this);
        
        let box = new St.BoxLayout();
        this.contentLayout.add_actor(box);
        
        let hoursBox = new St.BoxLayout({ vertical: true });
        box.add_actor(hoursBox);
        hoursBox.add_actor(new St.Label({ text: "Hours" }));
        this.hours = new Spinner({ max: 99, rollover: true, defaultValue: 0 });
        hoursBox.add_actor(this.hours.actor);
        
        let minutesBox = new St.BoxLayout({ vertical: true });
        box.add_actor(minutesBox);
        minutesBox.add_actor(new St.Label({ text: "Minutes" }));
        this.minutes = new Spinner({ max: 59, rollover: true, leadingZeros: true, defaultValue: 0 });
        minutesBox.add_actor(this.minutes.actor);
        this.minutes.connect("rollover", Lang.bind(this, function(object, isUp) {
            if ( isUp ) this.hours.increase();
            else this.hours.decrease();
        }));
        
        let secondsBox = new St.BoxLayout({ vertical: true });
        box.add_actor(secondsBox);
        secondsBox.add_actor(new St.Label({ text: "Seconds" }));
        this.seconds = new Spinner({ max: 59, rollover: true, leadingZeros: true, defaultValue: 0 });
        secondsBox.add_actor(this.seconds.actor);
        this.seconds.connect("rollover", Lang.bind(this, function(object, isUp) {
            if ( isUp ) this.minutes.increase();
            else this.minutes.decrease();
        }));
        
        this.setButtons([
            { label: "Cancel", key: "", focus: false, action: Lang.bind(this, this._onDialogCancel, this) },
            { label: "Ok", key: "", focus: true, action: Lang.bind(this, this._onDialogOk, this) }
        ]);
        
        this.open(global.get_current_time());
    },
    
    _onDialogOk: function() {
        this.close(global.get_current_time());
        
        let seconds = this.hours.getValue() * 3600;
        seconds += this.minutes.getValue() * 60;
        seconds += this.seconds.getValue();
        
        this.callback(seconds);
    },
    
    _onDialogCancel: function() {
        this.close(global.get_current_time());
    }
}


/* on-sreen item */
function DisplayItem() {
    this._init();
}

DisplayItem.prototype = {
    _init: function() {
        this.isVisible = true;
        
        this.actor = new St.BoxLayout({ vertical: true, reactive: true, track_hover: true, style_class: "timepiece-displayBox" });
        
        this.title = new St.Label({ style_class: "timepiece-displayBox-title" });
        this.actor.add_actor(this.title);
        
        this.contentBin = new St.Bin();
        this.actor.add(this.contentBin, { expand: true });
        this.buttonBox = new St.BoxLayout({ pack_start: true });
        this.actor.add(this.buttonBox);
        
        this.addButton("user-trash", "Remove", Lang.bind(this, this.destroy));
        this.addButton("window-minimize", "Hide", Lang.bind(this, this.hide));
        this.buttonBox.add(new St.Bin, { expand: true });
    },
    
    hide: function() {
        this.isVisible = false;
        this.actor.hide();
    },
    
    show: function() {
        this.isVisible = true;
        this.actor.show();
    },
    
    destroy: function() {
        displayBox.removeDisplayItem(this);
        this.actor.destroy();
        this.emit("destroy");
    },
    
    setContent: function(content) {
        this.contentBin.add_actor(content);
    },
    
    addButton: function(iconName, text, callback) {
        let button = new St.Button({ style_class: "timepiece-displayBox-button" });
        this.buttonBox.add_actor(button);
        let icon =  new St.Icon({ icon_name: iconName, icon_size: 16, icon_type: St.IconType.SYMBOLIC });
        button.add_actor(icon);
        button.connect("clicked", callback);
        let tooltip = new Tooltips.Tooltip(button, text);
        
        return { button: button, tooltip: tooltip, icon: icon };
    },
    
    setTitle: function(title) {
        this.title.text = String(title);
    }
}
Signals.addSignalMethods(DisplayItem.prototype);


/* container for DisplayItem objects */
function DisplayBox() {
    this._init();
}

DisplayBox.prototype = {
    _init: function() {
        this.items = [];
        
        this.actor = new Clutter.Actor();
        Main.uiGroup.add_actor(this.actor);
    },
    
    allocate: function(actor, box, flags) {
        let children = this.actor.get_children();
        for ( let child of children ) child.allocate_preferred_size(flags);
    },
    
    getPreferedHeight: function(actor, forWidth, alloc) {
        alloc.min_size = alloc.natural_size = global.stage.height;
    },
    
    getPreferedWidth: function(actor, forHeight, alloc) {
        alloc.min_size = alloc.natural_size = global.stage.width;
    },
    
    addDisplayItem: function(newItem) {
        this.actor.add_actor(newItem.actor);
        Main.layoutManager.addChrome(newItem.actor);
        this.items.push(newItem);
        this.updateStagePositions();
    },
    
    removeDisplayItem: function(item) {
        Main.layoutManager.removeChrome(item.actor);
        this.items.splice(this.items.indexOf(item), 1);
        this.updateStagePositions();
    },
    
    updateStagePositions: function() {
        let visibleCount = 0;
        for ( let item of this.items ) {
            if ( item.isVisible ) {
                let actor = item.actor;
                actor.x = 50;
                actor.y = visibleCount * 180 + 40;
                visibleCount++;
            }
        }
    }
}


// interfaces
function TimePieceItemBase() {
    this._init();
}

TimePieceItemBase.prototype = {
    _init: function() {
        
        this.display = new DisplayItem();
        displayBox.addDisplayItem(this.display);
        this.display.connect("destroy", Lang.bind(this, this.remove));
        
        this.menuItem = new PopupMenu.PopupMenuItem("");
        this.menuItem.connect("activate", Lang.bind(this.display, this.display.show));
    },
    
    setMenuText: function(text) {
        this.menuItem.label.text = text;
    },
    
    remove: function() {
        this.menuItem.destroy();
        this.emit("removed");
    }
}
Signals.addSignalMethods(TimePieceItemBase.prototype);


function StopWatchItem() {
    this._init();
}

StopWatchItem.prototype = {
    __proto__: TimePieceItemBase.prototype,
    
    _init: function() {
        TimePieceItemBase.prototype._init.call(this);
        
        this.elapsedTime = 0;
        
        this.display.setTitle("StopWatch");
        this.resetButton = this.display.addButton("view-refresh", "Reset", Lang.bind(this, this.reset));
        this.logButton = this.display.addButton("edit-copy", "Split", Lang.bind(this, this.logTime));
        this.playPauseButton = this.display.addButton("media-playback-start", "Start", Lang.bind(this, this.toggleStopwatch));
        
        this.buildDisplay();
        this.updateDisplay();
    },
    
    buildDisplay: function() {
        let timeLabelBox = new St.BoxLayout({ y_align: St.Align.END });
        this.display.setContent(timeLabelBox);
        
        this.hoursBox = new St.BoxLayout();
        timeLabelBox.add_actor(this.hoursBox);
        this.hoursLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        this.hoursBox.add_actor(this.hoursLabel);
        this.hoursBox.add_actor(new St.Label({ text: "h", style_class: "timepiece-timeLabel-divLabel" }));
        this.hoursBox.hide();
        
        this.minutesBox = new St.BoxLayout();
        timeLabelBox.add_actor(this.minutesBox);
        this.minutesLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        this.minutesBox.add_actor(this.minutesLabel);
        this.minutesBox.add_actor(new St.Label({ text: "m", style_class: "timepiece-timeLabel-divLabel" }));
        this.minutesBox.hide();
        
        this.secondsLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        timeLabelBox.add_actor(this.secondsLabel);
        timeLabelBox.add_actor(new St.Label({ text: "s", style_class: "timepiece-timeLabel-divLabel" }));
        
        this.millisecondsLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        timeLabelBox.add_actor(this.millisecondsLabel);
    },
    
    updateDisplay: function() {
        let time = this.elapsedTime;
        if ( this.counting ) time += new Date() - this.startTime;
        
        let hours = Math.floor(time/3600000);
        time -= hours*3600000;
        let minutes = Math.floor(time/60000);
        time -= minutes*60000
        let seconds = Math.floor((time)/1000);
        let milliseconds = Math.floor(time/10) - seconds * 100;
        
        let menuItemText = "";
        if ( hours == 0 ) this.hoursBox.hide();
        else {
            this.hoursBox.show();
            menuItemText = this.hoursLabel.text = String(hours);
            menuItemText += ":";
        }
        if ( minutes == 0 && hours == 0 ) this.minutesBox.hide();
        else {
            this.minutesBox.show();
            let minutesText = (minutes < 10 && hours != 0) ? "0" + minutes : String(minutes);
            this.minutesLabel.text = minutesText;
            menuItemText += minutesText + ":";
        }
        let secondsText = (seconds < 10 && hours+minutes != 0) ? "0" + seconds : String(seconds);
        this.secondsLabel.text = secondsText;
        let millisecondsText = (milliseconds < 10) ? "0" + milliseconds : String(milliseconds);
        this.millisecondsLabel.text = millisecondsText;
        menuItemText += secondsText + ":" + millisecondsText;
        
        this.menuItem.label.text = menuItemText;
        
        if ( this.counting ) return true;
        else return false;
    },
    
    toggleStopwatch: function() {
        if ( this.counting ) {
            this.counting = false;
            this.elapsedTime += new Date() - this.startTime;
            this.startTime = null;
            this.playPauseButton.icon.icon_name = "media-playback-start";
            this.playPauseButton.tooltip.set_text("Resume");
        }
        else {
            this.counting = true;
            this.startTime = new Date();
            this.playPauseButton.icon.icon_name = "media-playback-pause";
            this.playPauseButton.tooltip.set_text("Pause");
            this.updateDisplay();
            Mainloop.timeout_add(2, Lang.bind(this, this.updateDisplay));
        }
    },
    
    reset: function() {
        this.counting = false;
        this.startTime = null;
        this.elapsedTime = 0;
        this.updateDisplay();
    },
    
    logTime: function() {
        // needs implementing
    }
}


function TimerItem() {
    this._init();
}

TimerItem.prototype = {
    __proto__: TimePieceItemBase.prototype,
    
    _init: function() {
        TimePieceItemBase.prototype._init.call(this);
        
        this.seconds = 0;
        this.elapsedTime = 0;
        this.timerRunning = false;
        this.isNegative = false;
        
        this.display.setTitle("Timer");
        this.resetButton = this.display.addButton("view-refresh", "Reset", Lang.bind(this, this.reset));
        this.addTimeButton = this.display.addButton("list-add", "Add Time", Lang.bind(this, this.addTime));
        this.setTimeButton = this.display.addButton("alarm", "Set Time", Lang.bind(this, this.setTime));
        this.toggleButton = this.display.addButton("media-playback-start", "Start", Lang.bind(this, this.toggleTimer));
        
        this.buildDisplay();
        this.updateTimer();
    },
    
    buildDisplay: function() {
        let timeLabelBox = new St.BoxLayout({ y_align: St.Align.END });
        this.display.setContent(timeLabelBox);
        
        this.hoursLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        timeLabelBox.add_actor(this.hoursLabel);
        timeLabelBox.add_actor(new St.Label({ text: "h", style_class: "timepiece-timeLabel-divLabel" }));
        
        this.minutesLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        timeLabelBox.add_actor(this.minutesLabel);
        timeLabelBox.add_actor(new St.Label({ text: "m", style_class: "timepiece-timeLabel-divLabel" }));
        
        this.secondsLabel = new St.Label({ style_class: "timepiece-timeLabel-number" });
        timeLabelBox.add_actor(this.secondsLabel);
        timeLabelBox.add_actor(new St.Label({ text: "s", style_class: "timepiece-timeLabel-divLabel" }));
    },
    
    addTime: function() {
        new TimeSelectDialog(Lang.bind(this, this.addTimeFinish));
    },
    
    addTimeFinish: function(seconds) {
        this.elapsedTime -= seconds;
        this.updateTimer();
    },
    
    setTime: function() {
        new TimeSelectDialog(Lang.bind(this, this.setTimeFinish));
    },
    
    setTimeFinish: function(seconds) {
        this.seconds = seconds;
        this.reset();
        this.updateTimer();
    },
    
    toggleTimer: function() {
        if ( this.timerRunning ) {
            this.timerRunning = false;
            this.toggleButton.icon.icon_name = "media-playback-start";
            this.toggleButton.tooltip.set_text("Resume");
            
            this.elapsedTime += Math.floor((new Date() - this.startTime)/1000);
        }
        else {
            this.timerRunning = true;
            this.toggleButton.icon.icon_name = "media-playback-pause";
            this.toggleButton.tooltip.set_text("Stop");
            this.startTime = new Date();
            this.updateTimer();
            
            this.updateId = Mainloop.timeout_add(100, Lang.bind(this, this.updateTimer));
        }
    },
    
    updateTimer: function() {
        // here we get the number of seconds left until the time is up - we do this by taking the original
        // start time and subtracting time (if any) from previous runs; if the timer is running, we then subtract
        // the seconds that have elapsed since the timer was started.
        let secondsLeft = this.seconds - this.elapsedTime;
        if ( this.timerRunning ) secondsLeft -= Math.floor((new Date() - this.startTime)/1000);
        
        if ( secondsLeft < 0 ) {
            // if the time is less than zero and the alarm hasn't sounded, trigger the alarm
            if ( !this.isNegative && this.timerRunning ) Main.soundManager.playSoundFile(0, settings.timerSound);
            this.isNegative = true;
            secondsLeft = secondsLeft * -1;
        }
        else {
            this.isNegative = false;
        }
        
        let hours = Math.floor(secondsLeft/3600);
        let minutes = Math.floor((secondsLeft-hours*3600)/60);
        let seconds = secondsLeft - hours * 3600 - minutes * 60;
        
        this.hoursLabel.text = String(hours);
        let minutesText = (minutes < 10) ? "0" + minutes : String(minutes);
        this.minutesLabel.text = minutesText;
        let secondsText = (seconds < 10) ? "0" + seconds : String(seconds);
        this.secondsLabel.text = secondsText;
        
        if ( hours == 0 ) this.menuItem.label.text = minutes + ":" + secondsText;
        else this.menuItem.label.text = hours + ":" + minutesText + ":" + secondsText;
        
        if ( this.timerRunning ) return true;
        else return false;
    },
    
    reset: function() {
        if (this.timerRunning) this.toggleTimer();
        this.elapsedTime = 0;
        this.toggleButton.tooltip.set_text("Start");
    }
}


function AlarmItem(info) {
    this._init(info);
}

AlarmItem.prototype = {
    __proto__: TimePieceItemBase.prototype,
    
    _init: function(info) {
        TimePieceItemBase.prototype._init.call(this);
        
        this.display.setTitle("Alarm");
        
        this.ifaceSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
        this.use24h = this.ifaceSettings.get_boolean("clock-use-24h");
        
        if ( this.use24h ) {
            this.hours = info.hours;
        }
        else {
            if ( info.hours >= 12 ) {
                this.hours = info.hours - 12;
                this.isAM = false;
            }
            else {
                this.hours = info.hours;
                this.isAM = true;
            }
            if ( this.hours == 0 ) this.hours = 12;
        }
        this.minutes = info.minutes;
        
        this.buildDisplay();
    },
    
    buildDisplay: function() {
        let timeLabelBox = new St.BoxLayout();
        this.display.setContent(timeLabelBox);
        
        // hours label
        let hoursButton = new St.Button();
        timeLabelBox.add_actor(hoursButton);
        this.hoursLabel = new St.Label({ text: String(this.hours), style_class: "timepiece-timeLabel-number" });
        hoursButton.add_actor(this.hoursLabel);
        hoursButton.connect("button-release-event", Lang.bind(this, this.selectHours));
        hoursButton.connect("scroll-event", Lang.bind(this, function(actor, event) {
            this.scroll(event, "hours");
        }));
        
        timeLabelBox.add_actor(new St.Label({ text: ":", style_class: "timepiece-timeLabel-number" }));
        
        // minutes label
        let minutesButton = new St.Button();
        timeLabelBox.add_actor(minutesButton);
        this.minutesLabel = new St.Label({ text: String(this.minutes), style_class: "timepiece-timeLabel-number" });
        minutesButton.add_actor(this.minutesLabel);
        minutesButton.connect("button-release-event", Lang.bind(this, this.selectMinutes));
        minutesButton.connect("scroll-event", Lang.bind(this, function(actor, event) {
            this.scroll(event, "minutes");
        }));
        
        // AM/PM label
        if ( !this.use24h ) {
            let AMPMButton = new St.Button();
            timeLabelBox.add_actor(AMPMButton);
            this.AMPMLabel = new St.Label({ text: (this.isAM)?"AM":"PM", style_class: "timepiece-timeLabel-number" });
            AMPMButton.add_actor(this.AMPMLabel);
            AMPMButton.connect("button-release-event", Lang.bind(this, this.toggleAMPM));
            AMPMButton.connect("scroll-event", Lang.bind(this, this.toggleAMPM));
        }
        
        this.timeUpdated();
    },
    
    timeUpdated: function() {
        // update time labels
        let hoursText = String(this.hours);
        let minutesText = (this.minutes < 10) ? "0"+this.minutes : String(this.minutes);
        this.hoursLabel.text = hoursText;
        this.minutesLabel.text = minutesText;
        if ( !this.use24h ) this.AMPMLabel.text = (this.isAM) ? "AM" : "PM";
        
        // set menuItem text
        let menuString = hoursText + ":" + minutesText;
        if ( !this.use24h ) menuString += (this.isAM) ? " AM" : " PM";
        this.setMenuText(menuString);
        
        // set the alarm
        let now = new Date();
        let time = new Date();
        let hours = this.hours;
        if ( !this.use24h ) {
            if ( !this.isAM ) {
                hours += 12;
                if ( hours == 24 ) hours = 0;
            }
        }
        time.setHours(hours, this.minutes, 0, 0);
        
        if ( time < now ) time.setDate(time.getDate()+1);
        
        if ( this.timeoutId ) Mainloop.source_remove(this.timeoutId);
        this.timeoutId = Mainloop.timeout_add(time - now, Lang.bind(this, this.playSound));
        
        // update settings
        this.emit("changed");
    },
    
    get info() {
        info = { hours: this.hours, minutes: this.minutes };
        if ( !this.use24h ) {
            if ( info.hours == 12 ) info.hours = 0;
            if ( !this.isAM ) info.hours += 12;
        }
        return info;
    },
    
    selectHours: function() {
        if ( this.use24h ) {
            new ClockSelector(2, 24, this.hours, this.hoursLabel, Lang.bind(this, function(value) {
                this.hours = value;
                this.hoursLabel.text = String(value);
                this.timeUpdated();
            }));
        }
        else {
            new ClockSelector(1, 12, this.hours, this.hoursLabel, Lang.bind(this, function(value) {
                if ( value == 0 ) this.hours = 12;
                else this.hours = value;
                this.hoursLabel.text = String(this.hours);
                this.timeUpdated();
            }));
        }
    },
    
    selectMinutes: function() {
        new ClockSelector(5, 60, this.minutes, this.minutesLabel, Lang.bind(this, function(value) {
            this.minutes = value;
            this.timeUpdated();
        }));
    },
    
    toggleAMPM: function() {
        this.isAM = !this.isAM;
        this.timeUpdated();
    },
    
    playSound: function() {
        Main.soundManager.playSoundFile(0, settings.alarmSound);
    },
    
    scroll: function(event, type) {
        switch ( event.get_scroll_direction() ) {
            case Clutter.ScrollDirection.DOWN:
                this[type]--;
                break;
            case Clutter.ScrollDirection.UP:
                this[type]++;
                break;
            default:
                return;
        }
        
        // make sure everything is within bounds
        if ( this.minutes < 0 ) this.minutes = 60;
        else if ( this.minutes > 59 ) this.minutes = 0;
        if ( this.use24h ) {
            if ( this.hours < 0 ) this.hours = 23;
            else if ( this.hours > 23 ) this.hours = 0;
        }
        else {
            if ( this.hours < 1 ) this.hours = 12;
            else if ( this.hours > 12 ) this.hours = 1;
        }
        
        this.timeUpdated();
        this.clock.queue_repaint();
    }
}


function MyApplet(metadata, orientation, panel_height, instanceId) {
    this._init(metadata, orientation, panel_height, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,
    
    _init: function(metadata, orientation, panel_height, instanceId) {
        this.cairo = Cairo;
        this.orientation = orientation;
        button_path = metadata.path;
        Applet.TextIconApplet.prototype._init.call(this, this.orientation, panel_height);
        
        this.stopwatches = [];
        this.timers = [];
        this.alarms = [];
        
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);
        
        displayBox = new DisplayBox();
        
        this.buildMenu();
        this.generateItems();
        
        this.set_applet_icon_symbolic_name("preferences-system-time");
    },
    
    on_applet_clicked: function(event) {
        this.menu.toggle();
    },
    
    on_applet_removed_from_panel: function() {
        displayBox.actor.destroy();
    },
    
    buildMenu: function() {
        let newStopwatchItem = new PopupMenu.PopupIconMenuItem("New stop watch", "stopwatch", St.IconType.SYMBOLIC);
        this.menu.addMenuItem(newStopwatchItem);
        newStopwatchItem.connect("activate", Lang.bind(this, this.createNewStopwatch));
        
        let newAlarmItem = new PopupMenu.PopupIconMenuItem("New alarm", "alarm", St.IconType.SYMBOLIC);
        this.menu.addMenuItem(newAlarmItem);
        newAlarmItem.connect("activate", Lang.bind(this, function() {
            this.createNewAlarm();
        }));
        
        let newTimerItem = new PopupMenu.PopupIconMenuItem("New timer", "timer", St.IconType.SYMBOLIC);
        this.menu.addMenuItem(newTimerItem);
        newTimerItem.connect("activate", Lang.bind(this, this.createNewTimer));
        
        // stopwatch section
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.stopwatchSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.stopwatchSection);
        this.stopwatchSection.addMenuItem(new PopupMenu.PopupIconMenuItem("StopWatches", "stopwatch", St.IconType.SYMBOLIC));
        this.stopwatchSection.actor.hide();
        
        // timer section
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.timerSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.timerSection);
        this.timerSection.addMenuItem(new PopupMenu.PopupIconMenuItem("Timers", "alarm", St.IconType.SYMBOLIC));
        this.timerSection.actor.hide();
        
        // alarm section
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.alarmSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.alarmSection);
        this.alarmSection.addMenuItem(new PopupMenu.PopupIconMenuItem("Alarms", "timer", St.IconType.SYMBOLIC));
        this.alarmSection.actor.hide();
    },
    
    generateItems: function() {
        for ( let info of settings.alarms ) {
            this.createNewAlarm(info);
        }
    },
    
    createNewStopwatch: function() {
        let stopwatch = new StopWatchItem();
        this.stopwatches.push(stopwatch);
        this.stopwatchSection.addMenuItem(stopwatch.menuItem);
        this.stopwatchSection.actor.show();
        stopwatch.connect("removed", Lang.bind(this, function(stopwatch) {
            this.stopwatches.splice(this.stopwatches.indexOf(stopwatch), 1);
            if ( this.stopwatches.length == 0 ) this.stopwatchSection.actor.hide();
        }));
    },
    
    createNewTimer: function() {
        let timer = new TimerItem();
        this.timers.push(timer);
        this.timerSection.addMenuItem(timer.menuItem);
        this.timerSection.actor.show();
        timer.connect("removed", Lang.bind(this, function(timer) {
            this.timers.splice(this.timers.indexOf(timer), 1);
            if ( this.timers.length == 0 ) this.timerSection.actor.hide();
        }));
    },
    
    createNewAlarm: function(info) {
        if ( !info ) info = { hours: 6, minutes: 0 };
        let alarm = new AlarmItem(info);
        this.alarms.push(alarm);
        this.alarmSection.addMenuItem(alarm.menuItem);
        this.alarmSection.actor.show();
        alarm.connect("removed", Lang.bind(this, function(alarm) {
            this.alarms.splice(this.alarms.indexOf(alarm), 1);
            if ( this.alarms.length == 0 ) this.alarmSection.actor.hide();
            this.updateAlarmSettings();
        }));
        alarm.connect("changed", Lang.bind(this, function() {
            this.updateAlarmSettings();
        }));
        this.updateAlarmSettings();
    },
    
    updateAlarmSettings: function() {
        let alarms = [];
        for ( alarm of this.alarms ) {
            alarms.push(alarm.info);
        }
        settings.alarms = alarms;
    }
}


function main(metadata, orientation, panel_height, instanceId) {
    settings = new SettingsManager(metadata.uuid, instanceId);
    let myApplet = new MyApplet(metadata, orientation, panel_height, instanceId);
    return myApplet;
}
