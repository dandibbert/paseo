#import "ENRMTextInteractionUtils.h"
#import "LinkTapUtils.h"
#if !TARGET_OS_OSX
#import <UIKit/UIGestureRecognizerSubclass.h>
#include <math.h>

static const CGFloat kENRMMaxTapMovementPt = 10.0;

static BOOL ENRMAncestorScrollViewIsMoving(UIView * _Nullable view)
{
  UIView *cursor = view.superview;
  while (cursor != nil) {
    if ([cursor isKindOfClass:[UIScrollView class]]) {
      UIScrollView *scrollView = (UIScrollView *)cursor;
      if (scrollView.isDragging || scrollView.isDecelerating) {
        return YES;
      }
    }
    cursor = cursor.superview;
  }
  return NO;
}

@interface ENRMStrictTapGestureRecognizer : UITapGestureRecognizer <UIGestureRecognizerDelegate>
@end

@implementation ENRMStrictTapGestureRecognizer {
  CGPoint _initialWindowLocation;
  BOOL _hasInitialLocation;
}

- (instancetype)initWithTarget:(id)target action:(SEL)action
{
  self = [super initWithTarget:target action:action];
  if (self) {
    self.delegate = self;
  }
  return self;
}

- (void)reset
{
  [super reset];
  _initialWindowLocation = CGPointZero;
  _hasInitialLocation = NO;
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [super touchesBegan:touches withEvent:event];
  if (self.state == UIGestureRecognizerStateFailed) {
    return;
  }
  if (touches.count != 1 || [event allTouches].count != 1 || ENRMAncestorScrollViewIsMoving(self.view)) {
    self.state = UIGestureRecognizerStateFailed;
    return;
  }
  UITouch *touch = touches.anyObject;
  if (!touch) {
    self.state = UIGestureRecognizerStateFailed;
    return;
  }
  _initialWindowLocation = [touch locationInView:nil];
  _hasInitialLocation = YES;
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [super touchesMoved:touches withEvent:event];
  if (self.state == UIGestureRecognizerStateFailed || !_hasInitialLocation) {
    return;
  }
  UITouch *touch = touches.anyObject;
  if (!touch) {
    return;
  }
  CGPoint current = [touch locationInView:nil];
  if (hypot(current.x - _initialWindowLocation.x, current.y - _initialWindowLocation.y) > kENRMMaxTapMovementPt) {
    self.state = UIGestureRecognizerStateFailed;
  }
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  if (self.state != UIGestureRecognizerStateFailed && _hasInitialLocation) {
    UITouch *touch = touches.anyObject;
    if (touch) {
      CGPoint current = [touch locationInView:nil];
      if (hypot(current.x - _initialWindowLocation.x, current.y - _initialWindowLocation.y) > kENRMMaxTapMovementPt ||
          ENRMAncestorScrollViewIsMoving(self.view)) {
        self.state = UIGestureRecognizerStateFailed;
        return;
      }
    }
  }
  [super touchesEnded:touches withEvent:event];
}

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)gestureRecognizer
{
  (void)gestureRecognizer;
  return !ENRMAncestorScrollViewIsMoving(self.view);
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRequireFailureOfGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  (void)gestureRecognizer;
  UIView *otherView = otherGestureRecognizer.view;
  if (![otherView isKindOfClass:[UIScrollView class]]) {
    return NO;
  }
  UIScrollView *scrollView = (UIScrollView *)otherView;
  return otherGestureRecognizer == scrollView.panGestureRecognizer && [self.view isDescendantOfView:scrollView];
}

@end
#endif

ENRMTapRecognizer *ENRMCreateTextTapRecognizer(id target, SEL action)
{
#if !TARGET_OS_OSX
  return [[ENRMStrictTapGestureRecognizer alloc] initWithTarget:target action:action];
#else
  return [[ENRMTapRecognizer alloc] initWithTarget:target action:action];
#endif
}

BOOL ENRMHandleTapOnTextView(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer,
                             void (^onLinkPress)(NSString *url, NSString *sourceType))
{
  NSString *url = linkURLAtTapLocation(textView, recognizer);
  if (!url) {
    ENRMClearSelection(textView);
    return NO;
  }
  if (onLinkPress)
    onLinkPress(url, linkSourceTypeAtTapLocation(textView, recognizer));
  return YES;
}
